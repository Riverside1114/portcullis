#!/usr/bin/env node
/**
 * Command line entry point.
 *
 * The calling convention is deliberately `portcullis run [options] -- <command>`.
 * Everything after `--` is the original MCP server invocation, forwarded
 * untouched. That separator is what lets Portcullis wrap servers it has never
 * heard of, including ones written after it: it never has to parse, understand,
 * or have an opinion about the wrapped command.
 */

import { parseArgs } from "node:util";
import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { createLogger, isLogLevel, LOG_LEVELS, type Logger, type LogLevel } from "./logging.js";
import { runProxy, ServerLaunchError } from "./proxy.js";
import { Recorder, DEFAULT_MAX_PAYLOAD_BYTES } from "./recorder.js";
import { Session } from "./session.js";
import { logPathFor } from "./paths.js";
import { tail } from "./commands/tail.js";

const EXIT_USAGE = 64; // sysexits.h EX_USAGE
const EXIT_UNAVAILABLE = 69; // sysexits.h EX_UNAVAILABLE

function readVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const raw = readFileSync(join(here, "..", "package.json"), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === "object" && "version" in parsed) {
      const { version } = parsed as { version?: unknown };
      if (typeof version === "string") return version;
    }
  } catch {
    /* fall through */
  }
  return "0.0.0";
}

const HELP = `portcullis — a firewall and flight recorder for AI tool calls

USAGE
  portcullis run [options] -- <command> [args...]
  portcullis tail [server] [options]

COMMANDS
  run      Wrap an MCP server. Everything after -- is the server command,
           exactly as you would have written it in your agent's config.
  tail     Read the audit log back. With no server name, lists what exists.

RUN OPTIONS
  --name <name>        Label for this server, and the log filename.
                       Defaults to the command.
  --no-record          Pass traffic through without writing an audit log
  --max-payload <n>    Bytes of each payload to keep (default: ${DEFAULT_MAX_PAYLOAD_BYTES})
  --cwd <path>         Working directory for the wrapped server
  --log-level <level>  ${LOG_LEVELS.join(" | ")}   (default: info)
  --verbose            Shorthand for --log-level debug
  --quiet              Shorthand for --log-level error

TAIL OPTIONS
  -n <count>           Number of trailing records to show (default: 50, 0 = all)
  -f, --follow         Keep printing records as they arrive
  --json               Emit raw JSONL instead of the rendered view

GLOBAL
  -h, --help           Show this help
  -v, --version        Show the version

EXAMPLE
  Wrap the filesystem server in your agent config:

    "filesystem": {
      "command": "portcullis",
      "args": ["run", "--name", "filesystem", "--",
               "npx", "-y", "@modelcontextprotocol/server-filesystem", "/home/me"]
    }

  Then see what it did:

    portcullis tail filesystem

NOTES
  Diagnostics are written to stderr. stdout carries protocol traffic and is
  never written to by Portcullis itself.

  Logs live under ~/.portcullis/logs and never leave the machine.

  Full documentation: https://github.com/Riverside1114/portcullis
`;

export async function main(argv: readonly string[]): Promise<number> {
  // Split our own flags from the wrapped command before parsing, so that flags
  // belonging to the target server are never interpreted as ours.
  const separator = argv.indexOf("--");
  const ownArgs = separator === -1 ? [...argv] : argv.slice(0, separator);
  const targetArgv = separator === -1 ? [] : argv.slice(separator + 1);

  let parsed;
  try {
    parsed = parseArgs({
      args: ownArgs,
      allowPositionals: true,
      strict: true,
      options: {
        name: { type: "string" },
        "no-record": { type: "boolean", default: false },
        "max-payload": { type: "string" },
        cwd: { type: "string" },
        "log-level": { type: "string" },
        verbose: { type: "boolean", default: false },
        quiet: { type: "boolean", default: false },
        n: { type: "string" },
        follow: { type: "boolean", short: "f", default: false },
        json: { type: "boolean", default: false },
        help: { type: "boolean", short: "h", default: false },
        version: { type: "boolean", short: "v", default: false },
      },
    });
  } catch (error) {
    process.stderr.write(`portcullis: ${(error as Error).message}\n\n${HELP}`);
    return EXIT_USAGE;
  }

  const { values, positionals } = parsed;

  if (values.help) {
    process.stdout.write(HELP);
    return 0;
  }
  if (values.version) {
    process.stdout.write(`${readVersion()}\n`);
    return 0;
  }

  const subcommand = positionals[0];
  if (subcommand === undefined) {
    process.stderr.write(HELP);
    return EXIT_USAGE;
  }

  const level = resolveLogLevel(values);
  if (level === null) {
    process.stderr.write(
      `portcullis: invalid --log-level "${String(values["log-level"])}" ` +
        `(expected one of: ${LOG_LEVELS.join(", ")})\n`,
    );
    return EXIT_USAGE;
  }

  switch (subcommand) {
    case "run":
      return runCommand({ values, targetArgv, level });
    case "tail":
      return tail({
        server: positionals[1],
        count: parseCount(values.n, 50),
        follow: values.follow ?? false,
        json: values.json ?? false,
        out: process.stdout,
        err: process.stderr,
        colour: process.stdout.isTTY === true,
      });
    default:
      process.stderr.write(`portcullis: unknown command "${subcommand}"\n\n${HELP}`);
      return EXIT_USAGE;
  }
}

interface RunContext {
  values: {
    name?: string | undefined;
    "no-record"?: boolean;
    "max-payload"?: string | undefined;
    cwd?: string | undefined;
  };
  targetArgv: readonly string[];
  level: LogLevel;
}

async function runCommand({ values, targetArgv, level }: RunContext): Promise<number> {
  const command = targetArgv[0];
  if (command === undefined) {
    process.stderr.write(
      "portcullis: no server command given\n\n" +
        "  Put the MCP server you want to wrap after --, for example:\n" +
        "    portcullis run -- npx -y @modelcontextprotocol/server-filesystem .\n",
    );
    return EXIT_USAGE;
  }

  const name = values.name ?? basename(command);
  const logger = createLogger({ level, scope: name });

  const maxPayloadBytes = parseCount(values["max-payload"], DEFAULT_MAX_PAYLOAD_BYTES);

  // Recording is best-effort by design. If the log cannot be opened — read-only
  // home directory, full disk — Portcullis degrades to the M1 passthrough and
  // says so, rather than refusing to start and taking the agent down with it.
  const recorder = values["no-record"] ? null : await openRecorder(name, maxPayloadBytes, logger);
  const session = recorder ? new Session({ server: name, recorder, logger }) : undefined;

  if (recorder) logger.info(`recording to ${recorder.path}`);

  try {
    const outcome = await runProxy({
      command,
      args: targetArgv.slice(1),
      logger,
      ...(values.cwd === undefined ? {} : { cwd: values.cwd }),
      ...(session === undefined ? {} : { session }),
    });

    if (recorder) logger.info(`recorded ${recorder.recordsWritten} messages`);
    return outcome.code;
  } catch (error) {
    if (error instanceof ServerLaunchError) {
      logger.error(error.message);
      return EXIT_UNAVAILABLE;
    }
    logger.error("unexpected failure", error);
    return 1;
  } finally {
    // Flush before the process is allowed to end, or the tail of the session is
    // lost exactly when something has gone wrong and the log matters most.
    if (recorder) await recorder.close();
  }
}

async function openRecorder(
  name: string,
  maxPayloadBytes: number,
  logger: Logger,
): Promise<Recorder | null> {
  try {
    return await Recorder.open({ path: logPathFor(name), logger, maxPayloadBytes });
  } catch (error) {
    logger.warn("could not open the audit log, continuing without recording", error);
    return null;
  }
}

function resolveLogLevel(values: {
  verbose?: boolean;
  quiet?: boolean;
  "log-level"?: string | undefined;
}): LogLevel | null {
  const explicit = values["log-level"];
  if (explicit !== undefined) {
    return isLogLevel(explicit) ? explicit : null;
  }
  if (values.verbose) return "debug";
  if (values.quiet) return "error";
  return "info";
}

function parseCount(raw: string | undefined, fallback: number): number {
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function basename(command: string): string {
  const parts = command.split(/[\\/]/);
  return parts[parts.length - 1] ?? command;
}

// Only run when invoked directly, so tests can import `main` without it firing.
const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  void main(process.argv.slice(2)).then((code) => {
    // Assigning exitCode rather than calling process.exit() lets Node drain and
    // flush stdout before leaving. process.exit() truncates piped output, which
    // for a proxy means silently eating the tail of a protocol stream.
    process.exitCode = code;
  });
}
