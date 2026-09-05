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
import { createLogger, isLogLevel, LOG_LEVELS, type LogLevel } from "./logging.js";
import { runProxy, ServerLaunchError } from "./proxy.js";

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

  Everything after -- is the MCP server to wrap, exactly as you would have
  written it in your agent's config.

OPTIONS
  --name <name>        Label for this server in logs. Defaults to the command.
  --log-level <level>  ${LOG_LEVELS.join(" | ")}   (default: info)
  --verbose            Shorthand for --log-level debug
  --quiet              Shorthand for --log-level error
  --cwd <path>         Working directory for the wrapped server
  -h, --help           Show this help
  -v, --version        Show the version

EXAMPLE
  Wrap the filesystem server in your agent config:

    "filesystem": {
      "command": "portcullis",
      "args": ["run", "--name", "filesystem", "--",
               "npx", "-y", "@modelcontextprotocol/server-filesystem", "/home/me"]
    }

NOTES
  Diagnostics are written to stderr. stdout carries protocol traffic and is
  never written to by Portcullis itself.

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
        "log-level": { type: "string" },
        verbose: { type: "boolean", default: false },
        quiet: { type: "boolean", default: false },
        cwd: { type: "string" },
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
  if (subcommand !== "run") {
    process.stderr.write(`portcullis: unknown command "${subcommand}"\n\n${HELP}`);
    return EXIT_USAGE;
  }

  const level = resolveLogLevel(values);
  if (level === null) {
    process.stderr.write(
      `portcullis: invalid --log-level "${values["log-level"]}" ` +
        `(expected one of: ${LOG_LEVELS.join(", ")})\n`,
    );
    return EXIT_USAGE;
  }

  const command = targetArgv[0];
  if (command === undefined) {
    process.stderr.write(
      "portcullis: no server command given\n\n" +
        "  Put the MCP server you want to wrap after --, for example:\n" +
        "    portcullis run -- npx -y @modelcontextprotocol/server-filesystem .\n",
    );
    return EXIT_USAGE;
  }

  const logger = createLogger({ level, scope: values.name ?? basename(command) });

  try {
    const outcome = await runProxy({
      command,
      args: targetArgv.slice(1),
      logger,
      ...(values.cwd === undefined ? {} : { cwd: values.cwd }),
    });
    return outcome.code;
  } catch (error) {
    if (error instanceof ServerLaunchError) {
      logger.error(error.message);
      return EXIT_UNAVAILABLE;
    }
    logger.error("unexpected failure", error);
    return 1;
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

function basename(command: string): string {
  const parts = command.split(/[\/]/);
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
