/**
 * JSON-RPC 2.0 shapes and stdio framing.
 *
 * MCP over stdio is newline-delimited JSON: one complete message per line, no
 * embedded raw newlines. That is simple enough to be tempting to parse badly,
 * and there are two ways to get it wrong that only show up under load — both
 * are handled here rather than at the call site.
 */

import { StringDecoder } from "node:string_decoder";

export type JsonRpcId = string | number | null;

export interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface JsonRpcRequest {
  jsonrpc: "2.0";
  id: JsonRpcId;
  method: string;
  params?: unknown;
}

export interface JsonRpcNotification {
  jsonrpc: "2.0";
  method: string;
  params?: unknown;
}

export interface JsonRpcResponse {
  jsonrpc: "2.0";
  id: JsonRpcId;
  result?: unknown;
  error?: JsonRpcError;
}

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse;

/**
 * What a line turned out to be.
 *
 * `malformed` is a first-class outcome, not a failure. Portcullis observes a
 * stream it does not own; a server that emits a stray debug line on stdout is
 * misbehaving, but that is precisely the kind of thing the audit log exists to
 * capture. It is recorded and passed through, never swallowed.
 */
export type MessageKind = "request" | "notification" | "response" | "error" | "malformed";

/**
 * A discriminated union rather than one loose shape with everything optional.
 *
 * This is what lets a `switch (message.kind)` at the call site prove that a
 * request has a method and an error has an error object, instead of every
 * consumer re-checking fields the classifier already established. The compiler
 * enforces the invariant once, here.
 */
export type ClassifiedMessage =
  | { kind: "request"; id: JsonRpcId; method: string; params?: unknown }
  | { kind: "notification"; method: string; params?: unknown }
  | { kind: "response"; id: JsonRpcId; result?: unknown }
  | { kind: "error"; id: JsonRpcId; error: JsonRpcError }
  | { kind: "malformed"; reason: string };

export function classify(line: string): ClassifiedMessage {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch (cause) {
    return { kind: "malformed", reason: `not JSON: ${(cause as Error).message}` };
  }

  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { kind: "malformed", reason: "not a JSON-RPC object" };
  }

  const message = parsed as Record<string, unknown>;
  const hasId = "id" in message;
  const method = typeof message["method"] === "string" ? message["method"] : undefined;

  if (method !== undefined) {
    // A method with an id is a call; without one it is a notification and no
    // response will ever arrive for it. Correlation depends on this distinction.
    return hasId
      ? { kind: "request", id: message["id"] as JsonRpcId, method, params: message["params"] }
      : { kind: "notification", method, params: message["params"] };
  }

  if (hasId) {
    if ("error" in message) {
      return {
        kind: "error",
        id: message["id"] as JsonRpcId,
        error: message["error"] as JsonRpcError,
      };
    }
    return { kind: "response", id: message["id"] as JsonRpcId, result: message["result"] };
  }

  return { kind: "malformed", reason: "neither a method nor an id" };
}

/**
 * A key that distinguishes `1` from `"1"`.
 *
 * JSON-RPC requires a response to echo the request id with its type intact, so
 * a numeric 1 and a string "1" are genuinely different calls. Keying an
 * in-flight map on the bare value would let one call's response be attributed
 * to the other — rare, but it would silently corrupt the audit record, which is
 * the one thing the log must never do.
 */
export function correlationKey(id: JsonRpcId): string {
  return `${typeof id}:${String(id)}`;
}

/** Refuse to buffer more than this from a peer that never sends a newline. */
export const DEFAULT_MAX_LINE_BYTES = 64 * 1024 * 1024;

/**
 * Reassembles newline-delimited messages from arbitrary chunk boundaries.
 *
 * Two failure modes this exists to prevent:
 *
 * 1. Chunks do not respect message boundaries. A 2 MB tool result arrives as
 *    dozens of chunks, and the last one usually ends mid-message. Parsing each
 *    chunk on its own produces a stream of parse errors for perfectly valid
 *    traffic.
 *
 * 2. Chunks do not respect *character* boundaries either. `chunk.toString()`
 *    on a buffer that ends halfway through a multi-byte UTF-8 sequence yields a
 *    replacement character, permanently corrupting the text. StringDecoder holds
 *    the partial sequence until the rest arrives.
 */
export class LineFramer {
  readonly #decoder = new StringDecoder("utf8");
  readonly #maxLineBytes: number;
  #buffer = "";

  constructor(maxLineBytes: number = DEFAULT_MAX_LINE_BYTES) {
    this.#maxLineBytes = maxLineBytes;
  }

  /** Feeds a chunk in and returns whatever complete lines it completed. */
  push(chunk: Buffer): string[] {
    this.#buffer += this.#decoder.write(chunk);

    if (this.#buffer.length > this.#maxLineBytes) {
      // A peer streaming without newlines would otherwise grow this without
      // bound. Drop the buffer rather than exhaust memory; the traffic itself
      // still passes through untouched, only observation of it is given up.
      this.#buffer = "";
      return [];
    }

    const lines = this.#buffer.split("\n");
    // The final element is whatever came after the last newline — a partial
    // message, or "" if the chunk landed exactly on a boundary.
    this.#buffer = lines.pop() ?? "";

    return lines.map(stripCarriageReturn).filter((line) => line !== "");
  }

  /** Returns any trailing content left when the stream ends without a newline. */
  flush(): string[] {
    const remainder = this.#buffer + this.#decoder.end();
    this.#buffer = "";
    const line = stripCarriageReturn(remainder);
    return line === "" ? [] : [line];
  }
}

function stripCarriageReturn(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}
