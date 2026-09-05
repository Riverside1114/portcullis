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

export type MessageKind = "request" | "notification" | "response" | "error" | "malformed";

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

// A reply echoes the id with its type intact, so 1 and "1" are different calls.
// Keying on the bare value would misattribute one reply to the other.
export function correlationKey(id: JsonRpcId): string {
  return `${typeof id}:${String(id)}`;
}

export const DEFAULT_MAX_LINE_BYTES = 64 * 1024 * 1024;

export class LineFramer {
  readonly #decoder = new StringDecoder("utf8");
  readonly #maxLineBytes: number;
  #buffer = "";

  constructor(maxLineBytes: number = DEFAULT_MAX_LINE_BYTES) {
    this.#maxLineBytes = maxLineBytes;
  }

  push(chunk: Buffer): string[] {
    // StringDecoder, not chunk.toString(): a chunk can end halfway through a
    // multi-byte sequence, and toString() would substitute a replacement char.
    this.#buffer += this.#decoder.write(chunk);

    if (this.#buffer.length > this.#maxLineBytes) {
      // Give up observing rather than grow without bound. Traffic still flows.
      this.#buffer = "";
      return [];
    }

    const lines = this.#buffer.split("\n");
    this.#buffer = lines.pop() ?? "";

    return lines.map(stripCarriageReturn).filter((line) => line !== "");
  }

  flush(): string[] {
    const remainder = stripCarriageReturn(this.#buffer + this.#decoder.end());
    this.#buffer = "";
    return remainder === "" ? [] : [remainder];
  }
}

function stripCarriageReturn(line: string): string {
  return line.endsWith("\r") ? line.slice(0, -1) : line;
}
