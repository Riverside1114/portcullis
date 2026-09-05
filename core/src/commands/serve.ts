import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { createReadStream, existsSync, statSync, watchFile, unwatchFile } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { createInterface } from "node:readline";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import type { AuditRecord } from "../recorder.js";
import type { Logger } from "../logging.js";
import { logPathFor, logsDir, slugify } from "../paths.js";

export interface ServeOptions {
  port: number;
  host: string;
  logger: Logger;
  open?: boolean;
}

const DASHBOARD_DIR = fileURLToPath(new URL("../../dashboard/", import.meta.url));

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
};

export async function serve(options: ServeOptions): Promise<number> {
  const server = createServer((req, res) => {
    void handle(req, res, options.logger).catch((error) => {
      options.logger.error("request failed", error);
      if (!res.headersSent) send(res, 500, { error: "internal error" });
    });
  });

  return new Promise<number>((resolve) => {
    server.on("error", (error) => {
      options.logger.error(`could not start the dashboard: ${String(error)}`);
      resolve(1);
    });

    // Localhost only. The log holds file contents and API responses the agent
    // saw; it must not be reachable from the network.
    server.listen(options.port, options.host, () => {
      const url = `http://${options.host}:${options.port}`;
      options.logger.info(`dashboard on ${url}`);
      process.stdout.write(`Portcullis dashboard: ${url}\n`);
    });

    const stop = (): void => {
      server.close(() => resolve(0));
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

async function handle(req: IncomingMessage, res: ServerResponse, logger: Logger): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const path = url.pathname;

  if (path === "/api/servers") {
    return send(res, 200, await listServers());
  }

  if (path.startsWith("/api/log/")) {
    const name = decodeURIComponent(path.slice("/api/log/".length));
    return send(res, 200, await queryLog(name, url.searchParams));
  }

  if (path.startsWith("/api/stats/")) {
    const name = decodeURIComponent(path.slice("/api/stats/".length));
    return send(res, 200, await computeStats(name));
  }

  if (path.startsWith("/api/stream/")) {
    const name = decodeURIComponent(path.slice("/api/stream/".length));
    return streamLog(name, req, res, logger);
  }

  return serveStatic(path, res);
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  res.end(payload);
}

function serveStatic(path: string, res: ServerResponse): void {
  const relative = path === "/" ? "index.html" : path.replace(/^\/+/, "");

  // Reject traversal before touching the filesystem.
  const safe = normalize(relative).replace(/^(\.\.[/\\])+/, "");
  if (safe.includes("..")) {
    res.writeHead(403).end("forbidden");
    return;
  }

  const file = join(DASHBOARD_DIR, safe);
  if (!file.startsWith(DASHBOARD_DIR) || !existsSync(file)) {
    res.writeHead(404).end("not found");
    return;
  }

  res.writeHead(200, {
    "content-type": MIME[extname(file)] ?? "application/octet-stream",
    "cache-control": "no-store",
  });
  createReadStream(file).pipe(res);
}

interface ServerSummary {
  name: string;
  bytes: number;
  modified: string;
}

async function listServers(): Promise<ServerSummary[]> {
  const dir = logsDir();
  let entries: string[];
  try {
    entries = (await readdir(dir)).filter((name) => name.endsWith(".jsonl"));
  } catch {
    return [];
  }

  return entries
    .map((entry) => {
      const stats = statSync(join(dir, entry));
      return {
        name: entry.replace(/\.jsonl$/, ""),
        bytes: stats.size,
        modified: stats.mtime.toISOString(),
      };
    })
    .sort((a, b) => b.modified.localeCompare(a.modified));
}

// Reads the whole file. Fine at the sizes a single agent session produces; the
// Go collector on the roadmap is what makes this cheap for large archives.
async function readRecords(name: string): Promise<AuditRecord[]> {
  const path = logPathFor(slugify(name));
  if (!existsSync(path)) return [];

  const text = await readFile(path, "utf8");
  const records: AuditRecord[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    try {
      records.push(JSON.parse(line) as AuditRecord);
    } catch {
      // A partially written final line is expected while a proxy is running.
    }
  }
  return records;
}

interface LogPage {
  total: number;
  matched: number;
  records: AuditRecord[];
}

async function queryLog(name: string, params: URLSearchParams): Promise<LogPage> {
  const all = await readRecords(name);

  const kind = params.get("kind");
  const dir = params.get("dir");
  const verdict = params.get("verdict");
  const search = params.get("q")?.toLowerCase();
  const session = params.get("session");
  const limit = clampInt(params.get("limit"), 200, 1, 5000);

  const matched = all.filter((record) => {
    if (kind && record.kind !== kind) return false;
    if (dir && record.dir !== dir) return false;
    if (verdict && record.policy?.enforced !== verdict) return false;
    if (session && record.session !== session) return false;
    if (search) {
      const haystack = `${record.method ?? ""} ${record.reason ?? ""}`.toLowerCase();
      if (!haystack.includes(search)) return false;
    }
    return true;
  });

  return {
    total: all.length,
    matched: matched.length,
    records: matched.slice(-limit),
  };
}

interface MethodStat {
  method: string;
  calls: number;
  errors: number;
  p50: number;
  p95: number;
}

interface RuleStat {
  rule: string;
  fired: number;
  denied: number;
}

interface Stats {
  total: number;
  calls: number;
  errors: number;
  malformed: number;
  bytes: number;
  sessions: number;
  truncated: number;
  denied: number;
  asked: number;
  judged: number;
  firstSeen: string | null;
  lastSeen: string | null;
  methods: MethodStat[];
  rules: RuleStat[];
}

async function computeStats(name: string): Promise<Stats> {
  const records = await readRecords(name);

  const durations = new Map<string, number[]>();
  const errors = new Map<string, number>();
  const calls = new Map<string, number>();
  const sessions = new Set<string>();

  const ruleFired = new Map<string, number>();
  const ruleDenied = new Map<string, number>();

  let errorCount = 0;
  let malformed = 0;
  let truncated = 0;
  let bytes = 0;
  let denied = 0;
  let asked = 0;
  let judged = 0;

  for (const record of records) {
    sessions.add(record.session);
    bytes += record.bytes;
    if (record.truncated) truncated += 1;
    if (record.kind === "malformed") malformed += 1;

    if (record.kind === "request" && record.method) {
      calls.set(record.method, (calls.get(record.method) ?? 0) + 1);
    }

    if (record.policy) {
      judged += 1;
      if (record.policy.enforced === "deny") denied += 1;
      if (record.policy.verdict === "ask") asked += 1;
      const rule = record.policy.rule;
      if (rule) {
        ruleFired.set(rule, (ruleFired.get(rule) ?? 0) + 1);
        if (record.policy.enforced === "deny") {
          ruleDenied.set(rule, (ruleDenied.get(rule) ?? 0) + 1);
        }
      }
    }

    if (record.kind === "error") {
      errorCount += 1;
      if (record.method) errors.set(record.method, (errors.get(record.method) ?? 0) + 1);
    }

    if (record.ms !== undefined && record.method) {
      const list = durations.get(record.method) ?? [];
      list.push(record.ms);
      durations.set(record.method, list);
    }
  }

  const methods: MethodStat[] = [...calls.entries()]
    .map(([method, count]) => {
      const samples = (durations.get(method) ?? []).sort((a, b) => a - b);
      return {
        method,
        calls: count,
        errors: errors.get(method) ?? 0,
        p50: percentile(samples, 0.5),
        p95: percentile(samples, 0.95),
      };
    })
    .sort((a, b) => b.calls - a.calls);

  const rules: RuleStat[] = [...ruleFired.entries()]
    .map(([rule, fired]) => ({ rule, fired, denied: ruleDenied.get(rule) ?? 0 }))
    .sort((a, b) => b.fired - a.fired);

  return {
    total: records.length,
    calls: [...calls.values()].reduce((sum, n) => sum + n, 0),
    errors: errorCount,
    malformed,
    bytes,
    sessions: sessions.size,
    truncated,
    denied,
    asked,
    judged,
    rules,
    firstSeen: records[0]?.ts ?? null,
    lastSeen: records[records.length - 1]?.ts ?? null,
    methods,
  };
}

function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor(sorted.length * fraction));
  return sorted[index] ?? 0;
}

function streamLog(
  name: string,
  req: IncomingMessage,
  res: ServerResponse,
  logger: Logger,
): void {
  const path = logPathFor(slugify(name));
  if (!existsSync(path)) {
    res.writeHead(404).end("no such log");
    return;
  }

  res.writeHead(200, {
    "content-type": "text/event-stream",
    "cache-control": "no-store",
    connection: "keep-alive",
  });
  res.write(": connected\n\n");

  let offset = statSync(path).size;
  let pending = Promise.resolve();

  const drain = async (): Promise<void> => {
    const size = statSync(path).size;
    if (size < offset) offset = 0;
    if (size === offset) return;

    const stream = createReadStream(path, { start: offset, encoding: "utf8" });
    const reader = createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of reader) {
      if (line.trim() === "") continue;
      try {
        JSON.parse(line);
        res.write(`data: ${line}\n\n`);
      } catch {
        // Partial trailing line; it will arrive complete on the next tick.
      }
    }
    offset = size;
  };

  // watchFile rather than watch: the native watchers disagree across platforms
  // about append events.
  watchFile(path, { interval: 300 }, () => {
    pending = pending.then(drain).catch((error) => logger.debug("stream drain failed", error));
  });

  const heartbeat = setInterval(() => res.write(": ping\n\n"), 25_000);

  req.on("close", () => {
    clearInterval(heartbeat);
    unwatchFile(path);
  });
}

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  if (raw === null) return fallback;
  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
}
