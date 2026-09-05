/**
 * Diagnostics for Portcullis.
 *
 * The single most important rule in this file: **nothing here may ever write to
 * stdout.** When Portcullis runs as an MCP proxy, stdout is the protocol
 * channel back to the agent. A stray `console.log` there is not a cosmetic bug,
 * it is a corrupt JSON-RPC stream and a confused model. Everything goes to
 * stderr, which MCP clients treat as free-form server logging.
 */

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
  /** A child logger that prefixes every line, for tagging a subsystem. */
  child(scope: string): Logger;
}

export interface LoggerOptions {
  level: LogLevel;
  /** Where diagnostics go. Defaults to stderr and should stay that way. */
  stream?: NodeJS.WritableStream;
  /** Prefix applied to every line, e.g. the proxied server's name. */
  scope?: string;
}

function format(level: LogLevel, scope: string | undefined, message: string): string {
  const stamp = new Date().toISOString();
  const tag = scope ? `portcullis:${scope}` : "portcullis";
  return `[${stamp}] ${tag} ${level.padEnd(5)} ${message}`;
}

export function createLogger(options: LoggerOptions): Logger {
  const stream = options.stream ?? process.stderr;
  const threshold = LEVEL_RANK[options.level];

  const emit = (level: LogLevel, message: string, details: unknown[]): void => {
    if (LEVEL_RANK[level] > threshold) return;

    let line = format(level, options.scope, message);
    if (details.length > 0) {
      // Errors carry a stack worth keeping; anything else is inspected shallowly
      // so a large tool payload cannot flood the terminal.
      const rendered = details.map((detail) =>
        detail instanceof Error ? (detail.stack ?? detail.message) : summarise(detail),
      );
      line += ` ${rendered.join(" ")}`;
    }

    // Best effort. If diagnostics cannot be written we must not take the proxy
    // down with us — the traffic it is carrying matters more than the log line.
    try {
      stream.write(`${line}\n`);
    } catch {
      /* ignore */
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

const MAX_DETAIL_LENGTH = 500;

function summarise(value: unknown): string {
  if (typeof value === "string") return truncate(value);
  try {
    return truncate(JSON.stringify(value) ?? String(value));
  } catch {
    return String(value);
  }
}

function truncate(text: string): string {
  return text.length <= MAX_DETAIL_LENGTH
    ? text
    : `${text.slice(0, MAX_DETAIL_LENGTH)}… (${text.length} chars)`;
}
