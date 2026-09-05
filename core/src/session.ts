import { randomUUID } from "node:crypto";
import { classify, correlationKey, type JsonRpcId } from "./protocol.js";
import type { AuditRecord, Direction, PolicyOutcome, Recorder } from "./recorder.js";
import type { Logger } from "./logging.js";

interface InflightCall {
  method: string;
  startedAt: number;
  requestSeq: number;
}

export interface UnansweredCall {
  id: JsonRpcId;
  method: string;
  ageMs: number;
}

export interface SessionOptions {
  server: string;
  recorder: Recorder;
  logger: Logger;
  now?: () => number;
}

// Holds outstanding requests so each reply can be recorded with the method that
// produced it and its duration. A raw JSON-RPC reply carries only an id.
export class Session {
  readonly id: string;
  readonly server: string;

  readonly #recorder: Recorder;
  readonly #logger: Logger;
  readonly #now: () => number;
  readonly #inflight = new Map<string, InflightCall>();
  #seq = 0;

  constructor(options: SessionOptions) {
    this.id = randomUUID();
    this.server = options.server;
    this.#recorder = options.recorder;
    this.#logger = options.logger;
    this.#now = options.now ?? Date.now;
  }

  get inflightCount(): number {
    return this.#inflight.size;
  }

  // Never throws. This runs inside a stream carrying live protocol traffic.
  observe(dir: Direction, line: string, policy?: PolicyOutcome): void {
    try {
      this.#record(dir, line, policy);
    } catch (error) {
      this.#logger.warn("failed to record a message", error);
    }
  }

  #record(dir: Direction, line: string, policy?: PolicyOutcome): void {
    const message = classify(line);
    const seq = (this.#seq += 1);

    const record: AuditRecord = {
      v: 1,
      ts: new Date(this.#now()).toISOString(),
      session: this.id,
      server: this.server,
      seq,
      dir,
      kind: message.kind,
      bytes: Buffer.byteLength(line, "utf8"),
    };

    if (policy) record.policy = policy;

    switch (message.kind) {
      case "request": {
        record.id = message.id;
        record.method = message.method;
        record.params = message.params;
        this.#inflight.set(this.#key(dir, message.id), {
          method: message.method,
          startedAt: this.#now(),
          requestSeq: seq,
        });
        break;
      }

      case "notification": {
        // One-way by definition. Tracking these would leak the map.
        record.method = message.method;
        record.params = message.params;
        break;
      }

      case "response":
      case "error": {
        record.id = message.id;
        if (message.kind === "error") record.error = message.error;
        else record.result = message.result;

        const pending = this.#takeInflight(dir, record.id);
        if (pending) {
          record.method = pending.method;
          record.ms = this.#now() - pending.startedAt;
        } else {
          record.reason = "no matching request observed";
        }
        break;
      }

      case "malformed": {
        record.reason = message.reason;
        break;
      }
    }

    this.#recorder.write(record);
  }

  /** Calls sent but never answered. An agent hides this; the model just waits. */
  unanswered(): UnansweredCall[] {
    const now = this.#now();
    const result: UnansweredCall[] = [];
    for (const [key, call] of this.#inflight) {
      result.push({ id: idFromKey(key), method: call.method, ageMs: now - call.startedAt });
    }
    return result;
  }

  // Keyed by direction as well as id. Both sides may originate calls, so the
  // two id spaces can legitimately collide.
  #key(dir: Direction, id: JsonRpcId): string {
    return `${dir}|${correlationKey(id)}`;
  }

  #takeInflight(responseDir: Direction, id: JsonRpcId): InflightCall | undefined {
    const requestDir: Direction = responseDir === "to-agent" ? "to-server" : "to-agent";
    const key = this.#key(requestDir, id);
    const call = this.#inflight.get(key);
    if (call) this.#inflight.delete(key);
    return call;
  }
}

function idFromKey(key: string): JsonRpcId {
  const rest = key.slice(key.indexOf("|") + 1);
  const split = rest.indexOf(":");
  const type = rest.slice(0, split);
  const value = rest.slice(split + 1);
  if (type === "number") return Number(value);
  if (type === "object") return null;
  return value;
}
