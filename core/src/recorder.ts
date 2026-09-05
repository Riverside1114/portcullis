/**
 * The append-only audit log.
 *
 * One JSON object per line, one file per proxied server. The format is
 * deliberately boring: JSONL is greppable, tailable, and readable by anything,
 * which matters more here than compactness. If Portcullis is ever the thing you
 * reach for after an incident, the log must be legible without Portcullis.
 *
 * Records carry a schema version so later tooling can read older logs.
 */

import { createWriteStream, type WriteStream } from "node:fs";
import { dirname } from "node:path";
import type { JsonRpcError, JsonRpcId, MessageKind } from "./protocol.js";
import type { Logger } from "./logging.js";
import { ensureDir } from "./paths.js";

/** Which way a message was travelling when it was observed. */
export type Direction = "to-server" | "to-agent";

export const AUDIT_SCHEMA_VERSION = 1;

export interface AuditRecord {
  /** Schema version, so a reader can tell what it is looking at. */
  v: number;
  /** ISO 8601, always UTC. */
  ts: string;
  /** Groups every record from one run of one server. */
  session: string;
  server: string;
  /** Monotonic within a session — survives identical timestamps. */
  seq: number;
  dir: Direction;
  kind: MessageKind;
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: JsonRpcError;
  /** Milliseconds from request to response. Only on records that answer one. */
  ms?: number;
  /** Size of the message as it appeared on the wire. */
  bytes: number;
  /** Set when a payload was too large to store whole. */
  truncated?: boolean;
  /** For malformed lines: why they could not be understood. */
  reason?: string;
}

/**
 * How much of a single payload to keep.
 *
 * A tool result can be an entire file. Storing all of it turns the log into a
 * second copy of the filesystem; storing none of it makes the log useless for
 * answering what actually happened. 32 KiB keeps the shape of almost every real
 * call while bounding the worst case.
 */
export const DEFAULT_MAX_PAYLOAD_BYTES = 32 * 1024;

export interface RecorderOptions {
  path: string;
  logger: Logger;
  maxPayloadBytes?: number;
}

export class Recorder {
  readonly path: string;
  readonly #stream: WriteStream;
  readonly #logger: Logger;
  readonly #maxPayloadBytes: number;
  #broken = false;
  #written = 0;

  private constructor(path: string, stream: WriteStream, options: RecorderOptions) {
    this.path = path;
    this.#stream = stream;
    this.#logger = options.logger;
    this.#maxPayloadBytes = options.maxPayloadBytes ?? DEFAULT_MAX_PAYLOAD_BYTES;
  }

  static async open(options: RecorderOptions): Promise<Recorder> {
    await ensureDir(dirname(options.path));

    // 'a' is what makes this append-only in practice: concurrent proxies for
    // different servers can share a directory, and a crash never truncates the
    // history that was already written.
    const stream = createWriteStream(options.path, { flags: "a", mode: 0o600 });

    const recorder = new Recorder(options.path, stream, options);

    stream.on("error", (error) => {
      // A full disk must not take down the traffic Portcullis is carrying.
      // Report once, then degrade to passthrough for the rest of the session.
      if (!recorder.#broken) {
        recorder.#broken = true;
        options.logger.error(`audit log write failed, recording disabled: ${String(error)}`);
      }
    });

    return recorder;
  }

  get recordsWritten(): number {
    return this.#written;
  }

  write(record: AuditRecord): void {
    if (this.#broken) return;

    const fitted: AuditRecord = { ...record };
    let truncated = false;

    for (const field of ["params", "result"] as const) {
      if (fitted[field] === undefined) continue;
      const outcome = clampPayload(fitted[field], this.#maxPayloadBytes);
      fitted[field] = outcome.value;
      truncated ||= outcome.truncated;
    }
    if (truncated) fitted.truncated = true;

    let line: string;
    try {
      line = JSON.stringify(fitted);
    } catch (error) {
      this.#logger.warn("could not serialise an audit record", error);
      return;
    }

    this.#stream.write(`${line}\n`);
    this.#written += 1;
  }

  async close(): Promise<void> {
    await new Promise<void>((resolve) => {
      this.#stream.end(() => resolve());
    });
  }
}

interface ClampResult {
  value: unknown;
  truncated: boolean;
}

/**
 * Replaces an oversized payload with a marker that keeps its head and its true
 * size. The marker is a plain object so the log stays valid JSONL, and it
 * records the original byte count so a reader can tell how much is missing.
 */
function clampPayload(value: unknown, maxBytes: number): ClampResult {
  let json: string;
  try {
    json = JSON.stringify(value) ?? "null";
  } catch {
    return { value: { "@portcullis": "unserialisable" }, truncated: true };
  }

  const bytes = Buffer.byteLength(json, "utf8");
  if (bytes <= maxBytes) return { value, truncated: false };

  return {
    value: {
      "@portcullis": "truncated",
      bytes,
      head: json.slice(0, maxBytes),
    },
    truncated: true,
  };
}
