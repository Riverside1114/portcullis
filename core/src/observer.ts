/**
 * A stream that watches traffic without touching it.
 *
 * This is the seam M1 left open. It sits between the agent and the server in
 * place of a direct pipe, reassembles messages from the byte stream, and hands
 * each complete line to a callback.
 *
 * The contract is narrow and absolute: **the bytes that come out are the exact
 * bytes that went in.** Observation never re-serialises, never reformats, never
 * reorders, and never delays. If parsing fails the traffic still flows — a
 * message Portcullis cannot understand is still a message the agent is entitled
 * to receive. This is what makes design rule 1, transparent by default,
 * something the code guarantees rather than something the README claims.
 */

import { Transform, type TransformCallback } from "node:stream";
import { LineFramer } from "./protocol.js";

export interface ObserverOptions {
  /** Called once per complete message seen on the wire. */
  onLine: (line: string) => void;
  /** Called if observation itself fails. Traffic continues regardless. */
  onError?: (error: unknown) => void;
  maxLineBytes?: number;
}

class Observer extends Transform {
  readonly #framer: LineFramer;
  readonly #onLine: (line: string) => void;
  readonly #onError: (error: unknown) => void;

  constructor(options: ObserverOptions) {
    super();
    this.#framer =
      options.maxLineBytes === undefined ? new LineFramer() : new LineFramer(options.maxLineBytes);
    this.#onLine = options.onLine;
    this.#onError = options.onError ?? (() => {});
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback): void {
    try {
      for (const line of this.#framer.push(chunk)) {
        this.#onLine(line);
      }
    } catch (error) {
      // Nothing here is allowed to prevent the chunk being passed on.
      this.#onError(error);
    }

    // The original buffer, unmodified. Not a copy, not a re-encode.
    callback(null, chunk);
  }

  override _flush(callback: TransformCallback): void {
    try {
      for (const line of this.#framer.flush()) {
        this.#onLine(line);
      }
    } catch (error) {
      this.#onError(error);
    }
    callback();
  }
}

export function createObserver(options: ObserverOptions): Transform {
  return new Observer(options);
}
