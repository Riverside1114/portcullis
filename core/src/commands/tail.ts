/**
 * `portcullis tail` — read the audit log back.
 *
 * The log is JSONL precisely so it can be read with `tail -f` and `jq`, and
 * this command is not trying to replace those. What it adds is correlation the
 * raw file cannot show at a glance: a response rendered next to the method that
 * produced it, and the time it took. That is the question people actually have
 * when they open the log — not "what messages went past" but "what did it do,
 * and what happened".
 */

import { createReadStream, existsSync, statSync, watchFile, unwatchFile } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { join } from "node:path";
import type { AuditRecord } from "../recorder.js";
import { logPathFor, logsDir } from "../paths.js";

export interface TailOptions {
  /** Server name to read. When absent, the available logs are listed instead. */
  server?: string | undefined;
  /** How many trailing records to show. */
  count: number;
  /** Keep the process alive and print records as they are appended. */
  follow: boolean;
  /** Emit the raw records instead of the rendered view. */
  json: boolean;
  out: NodeJS.WritableStream;
  err: NodeJS.WritableStream;
  /** Colour is suppressed when the output is redirected. */
  colour?: boolean;
}

export async function tail(options: TailOptions): Promise<number> {
  if (options.server === undefined) {
    return listServers(options);
  }

  const path = logPathFor(options.server);
  if (!existsSync(path)) {
    options.err.write(
      `portcullis: no log for "${options.server}" at ${path}\n` +
        "  Logs are created the first time a server is proxied under that name.\n",
    );
    return 1;
  }

  const records = await readRecords(path);
  const window = options.count > 0 ? records.slice(-options.count) : records;
  for (const record of window) {
    options.out.write(render(record, options));
  }

  if (!options.follow) return 0;
  await followFrom(path, statSync(path).size, options);
  return 0;
}

async function listServers(options: TailOptions): Promise<number> {
  const dir = logsDir();
  let entries: string[];
  try {
    entries = (await readdir(dir)).filter((name) => name.endsWith(".jsonl"));
  } catch {
    options.err.write(`portcullis: no logs yet (${dir} does not exist)\n`);
    return 1;
  }

  if (entries.length === 0) {
    options.err.write(`portcullis: no logs yet in ${dir}\n`);
    return 1;
  }

  options.out.write(`Audit logs in ${dir}\n\n`);
  for (const entry of entries.sort()) {
    const name = entry.replace(/\.jsonl$/, "");
    const { size, mtime } = statSync(join(dir, entry));
    options.out.write(
      `  ${name.padEnd(24)} ${formatBytes(size).padStart(9)}   last write ${mtime.toISOString()}\n`,
    );
  }
  options.out.write(`\nRead one with: portcullis tail <name>\n`);
  return 0;
}

async function readRecords(path: string): Promise<AuditRecord[]> {
  const text = await readFile(path, "utf8");
  const records: AuditRecord[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const record = parseRecord(line);
    if (record) records.push(record);
  }
  return records;
}

function parseRecord(line: string): AuditRecord | null {
  try {
    return JSON.parse(line) as AuditRecord;
  } catch {
    // A partially written final line is expected while a proxy is running.
    return null;
  }
}

/**
 * Polls for appended records.
 *
 * `watchFile` rather than `watch` because this has to behave identically on
 * Windows, macOS and Linux, and the native watchers disagree about append
 * events. Reading only from the last known offset keeps this cheap regardless
 * of how large the log has grown.
 */
async function followFrom(path: string, startOffset: number, options: TailOptions): Promise<void> {
  let offset = startOffset;
  let pending = Promise.resolve();

  const drain = async (): Promise<void> => {
    const size = statSync(path).size;
    if (size < offset) {
      // The file was replaced or rotated underneath us. Start over from the top.
      offset = 0;
    }
    if (size === offset) return;

    const stream = createReadStream(path, { start: offset, encoding: "utf8" });
    const reader = createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of reader) {
      if (line.trim() === "") continue;
      const record = parseRecord(line);
      if (record) options.out.write(render(record, options));
    }
    offset = size;
  };

  watchFile(path, { interval: 200 }, () => {
    pending = pending.then(drain).catch(() => {});
  });

  await new Promise<void>((resolve) => {
    const stop = (): void => {
      unwatchFile(path);
      resolve();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

const ANSI = {
  reset: "[0m",
  dim: "[2m",
  red: "[31m",
  yellow: "[33m",
  green: "[32m",
  cyan: "[36m",
};

function render(record: AuditRecord, options: TailOptions): string {
  if (options.json) return `${JSON.stringify(record)}\n`;

  const paint = (code: string, text: string): string =>
    options.colour ? `${code}${text}${ANSI.reset}` : text;

  const time = record.ts.slice(11, 23);
  const arrow = record.dir === "to-server" ? "-->" : "<--";
  const method = record.method ?? "(uncorrelated)";

  let status: string;
  switch (record.kind) {
    case "request":
      status = paint(ANSI.dim, "call");
      break;
    case "notification":
      status = paint(ANSI.dim, "notify");
      break;
    case "response":
      status = paint(ANSI.green, "ok");
      break;
    case "error":
      status = paint(ANSI.red, `error ${record.error?.code ?? "?"}`);
      break;
    case "malformed":
      status = paint(ANSI.yellow, `malformed: ${abbreviate(record.reason ?? "unknown", 34)}`);
      break;
  }

  const duration = record.ms === undefined ? "" : paint(ANSI.dim, `${record.ms}ms`.padStart(8));
  const size = paint(ANSI.dim, formatBytes(record.bytes).padStart(9));
  const flag = record.truncated === true ? paint(ANSI.yellow, " [truncated]") : "";

  return (
    `${paint(ANSI.dim, time)}  ${paint(ANSI.cyan, arrow)}  ` +
    `${method.padEnd(30)} ${status.padEnd(options.colour ? 22 : 12)}${duration} ${size}${flag}\n`
  );
}

/** Keeps one long field from destroying the alignment of every other column. */
function abbreviate(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit - 1)}…`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
