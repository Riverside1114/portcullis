import { Transform, type TransformCallback } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { classify, type ClassifiedMessage, type JsonRpcId } from "./protocol.js";

// JSON-RPC reserves -32000 to -32099 for implementation-defined server errors.
export const POLICY_DENIED_CODE = -32001;

export type GateAction = "forward" | "drop";

export interface GateOptions {
  /** Called for every complete message. Return "drop" to refuse it. */
  decide?: (message: ClassifiedMessage, text: string) => GateAction;
  /** Called for every complete message, whatever the decision. */
  observe?: (text: string) => void;
  /** Reports a message too large to evaluate, carrying any id found in it. */
  onOversize?: (id: JsonRpcId | undefined) => void;
  onError?: (error: unknown) => void;
  maxMessageBytes?: number;
}

/**
 * Sixteen megabytes. Far above any real MCP message, and small enough that a
 * peer streaming without a newline cannot exhaust memory before it is noticed.
 */
export const DEFAULT_MAX_MESSAGE_BYTES = 16 * 1024 * 1024;

/**
 * Reassembles the byte stream into whole messages so each one can be judged,
 * then forwards the accepted ones with their original bytes untouched.
 *
 * Unlike the recording observer this necessarily buffers to message
 * boundaries, because a decision cannot be made on half a message. Recording
 * without a policy still uses the zero-buffering path.
 */
class Gate extends Transform {
  readonly #decoder = new StringDecoder("utf8");
  readonly #options: GateOptions;
  readonly #max: number;
  #buffer = "";

  constructor(options: GateOptions) {
    super();
    this.#options = options;
    this.#max = options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
  }

  /**
   * Emits a message that did not come from the wire, such as a denial.
   *
   * Safe because this transform only ever pushes whole messages, so an injected
   * line always lands on a boundary and can never split one.
   */
  inject(text: string): void {
    this.push(Buffer.from(`${text}\n`, "utf8"));
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    this.#buffer += this.#decoder.write(chunk);

    if (this.#buffer.length > this.#max) {
      const id = idFromPartial(this.#buffer);
      this.#buffer = "";
      try {
        this.#options.onOversize?.(id);
      } catch (error) {
        this.#options.onError?.(error);
      }
      callback();
      return;
    }

    const parts = this.#buffer.split("\n");
    this.#buffer = parts.pop() ?? "";

    for (const part of parts) {
      this.#handle(part, `${part}\n`);
    }

    callback();
  }

  override _flush(callback: TransformCallback): void {
    const rest = this.#buffer + this.#decoder.end();
    this.#buffer = "";
    if (rest !== "") this.#handle(rest, rest);
    callback();
  }

  #handle(part: string, raw: string): void {
    // A trailing carriage return belongs to the line ending, not the payload,
    // but it stays in `raw` so forwarding is byte for byte.
    const text = part.endsWith("\r") ? part.slice(0, -1) : part;

    if (text.trim() === "") {
      this.push(Buffer.from(raw, "utf8"));
      return;
    }

    let action: GateAction = "forward";
    try {
      this.#options.observe?.(text);
      if (this.#options.decide) {
        action = this.#options.decide(classify(text), text);
      }
    } catch (error) {
      this.#options.onError?.(error);
    }

    if (action === "forward") this.push(Buffer.from(raw, "utf8"));
  }
}

export type GateStream = Transform & { inject(text: string): void };

export function createGate(options: GateOptions): GateStream {
  return new Gate(options) as GateStream;
}

export interface DenialDetails {
  rule?: string | undefined;
  reason?: string | undefined;
  tool?: string | undefined;
  method?: string | undefined;
  limited?: boolean | undefined;
}

/**
 * Builds the error the agent receives in place of a denied call.
 *
 * The wording matters: models read this and act on it. It has to say the call
 * was refused by policy rather than that it failed, so the model looks for
 * another way instead of retrying the same call.
 */
export function denialResponse(id: JsonRpcId, details: DenialDetails): string {
  const head = details.rule
    ? `Blocked by Portcullis policy "${details.rule}"`
    : "Blocked by Portcullis policy";
  const body = details.reason ? `${head}: ${details.reason}` : head;
  const message = /[.!?]$/.test(body) ? body : `${body}.`;

  return JSON.stringify({
    jsonrpc: "2.0",
    id,
    error: {
      code: POLICY_DENIED_CODE,
      message: `${message} This call was not sent to the server. Do not retry it unchanged.`,
      data: {
        portcullis: "denied",
        ...(details.rule === undefined ? {} : { rule: details.rule }),
        ...(details.reason === undefined ? {} : { reason: details.reason }),
        ...(details.method === undefined ? {} : { method: details.method }),
        ...(details.tool === undefined ? {} : { tool: details.tool }),
        ...(details.limited ? { rateLimited: true } : {}),
      },
    },
  });
}

/** Best effort id recovery from a message too large to parse. */
function idFromPartial(text: string): JsonRpcId | undefined {
  const match = /"id"\s*:\s*(?:(-?\d+)|"((?:[^"\\]|\\.)*)")/.exec(text.slice(0, 4096));
  if (!match) return undefined;
  return match[1] !== undefined ? Number.parseInt(match[1], 10) : (match[2] as string);
}
