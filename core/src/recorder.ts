import { createWriteStream, type WriteStream } from "node:fs";
import { dirname } from "node:path";
import type { JsonRpcError, JsonRpcId, MessageKind } from "./protocol.js";
import type { Verdict } from "./policy/schema.js";
import type { Logger } from "./logging.js";
import { ensureDir } from "./paths.js";

export type Direction = "to-server" | "to-agent";

export const AUDIT_SCHEMA_VERSION = 1;

export interface PolicyOutcome {
  /** What the policy decided. */
  verdict: Verdict;
  /** What actually happened. Differs from verdict when ask has no approver. */
  enforced: "allow" | "deny";
  rule?: string;
  reason?: string;
  limited?: boolean;
}

export interface AuditRecord {
  v: number;
  ts: string;
  session: string;
  server: string;
  /** Monotonic within a session. Timestamps collide; this does not. */
  seq: number;
  dir: Direction;
  kind: MessageKind;
  id?: JsonRpcId;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: JsonRpcError;
  /** Milliseconds from request to reply, on correlated replies only. */
  ms?: number;
  /** Size on the wire, always the true size even when the payload is clamped. */
  bytes: number;
  truncated?: boolean;
  reason?: string;
  /** Present when a policy was active and judged this message. */
  policy?: PolicyOutcome;
}

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

    // Append mode: a crash never truncates history already written, and several
    // proxies can share the directory. 0600 because the log holds file contents
    // and API responses the agent saw.
    const stream = createWriteStream(options.path, { flags: "a", mode: 0o600 });
    const recorder = new Recorder(options.path, stream, options);

    stream.on("error", (error) => {
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

// A tool result can be a whole file. Keeping all of it makes the log a second
// copy of the filesystem; keeping none makes it useless. Keep the head and the
// true size. This affects the log only, never the wire.
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
    value: { "@portcullis": "truncated", bytes, head: json.slice(0, maxBytes) },
    truncated: true,
  };
}
