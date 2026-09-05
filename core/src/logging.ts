// Diagnostics go to stderr only. stdout is the MCP protocol channel; a stray
// line there corrupts the JSON-RPC stream.

export type LogLevel = "silent" | "error" | "warn" | "info" | "debug";

const LEVEL_RANK: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

export const LOG_LEVELS = Object.keys(LEVEL_RANK) as LogLevel[];

export function isLogLevel(value: string): value is LogLevel {
  return Object.prototype.hasOwnProperty.call(LEVEL_RANK, value);
}

export interface Logger {
  error(message: string, ...details: unknown[]): void;
  warn(message: string, ...details: unknown[]): void;
  info(message: string, ...details: unknown[]): void;
  debug(message: string, ...details: unknown[]): void;
  child(scope: string): Logger;
}

export interface LoggerOptions {
  level: LogLevel;
  stream?: NodeJS.WritableStream;
  scope?: string;
}

const MAX_DETAIL_LENGTH = 500;

export function createLogger(options: LoggerOptions): Logger {
  const stream = options.stream ?? process.stderr;
  const threshold = LEVEL_RANK[options.level];

  const emit = (level: LogLevel, message: string, details: unknown[]): void => {
    if (LEVEL_RANK[level] > threshold) return;

    const tag = options.scope ? `portcullis:${options.scope}` : "portcullis";
    let line = `[${new Date().toISOString()}] ${tag} ${level.padEnd(5)} ${message}`;

    if (details.length > 0) {
      line += ` ${details.map(summarise).join(" ")}`;
    }

    try {
      stream.write(`${line}\n`);
    } catch {
      // Losing a diagnostic must not take down the traffic being proxied.
    }
  };

  return {
    error: (message, ...details) => emit("error", message, details),
    warn: (message, ...details) => emit("warn", message, details),
    info: (message, ...details) => emit("info", message, details),
    debug: (message, ...details) => emit("debug", message, details),
    child: (scope) =>
      createLogger({
        ...options,
        scope: options.scope ? `${options.scope}:${scope}` : scope,
      }),
  };
}

function summarise(detail: unknown): string {
  if (detail instanceof Error) return detail.stack ?? detail.message;
  if (typeof detail === "string") return truncate(detail);
  try {
    return truncate(JSON.stringify(detail) ?? String(detail));
  } catch {
    return String(detail);
  }
}

function truncate(text: string): string {
  return text.length <= MAX_DETAIL_LENGTH
    ? text
    : `${text.slice(0, MAX_DETAIL_LENGTH)}... (${text.length} chars)`;
}
