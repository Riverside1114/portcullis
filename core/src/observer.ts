import { Transform, type TransformCallback } from "node:stream";
import { LineFramer } from "./protocol.js";

export interface ObserverOptions {
  onLine: (line: string) => void;
  onError?: (error: unknown) => void;
  maxLineBytes?: number;
}

// Watches traffic without altering it. The bytes written out are the exact
// bytes read in: no re-serialising, no reordering, no delay. If observation
// throws, the traffic still flows.
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
      this.#onError(error);
    }

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
