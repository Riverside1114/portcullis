#!/usr/bin/env node
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
import { serve } from "./commands/serve.js";
import { check } from "./commands/check.js";
import { loadPolicy, PolicyEngine, PolicyLoadError } from "./policy/index.js";
import type { PolicyRuntime } from "./proxy.js";

const EXIT_USAGE = 64;
const EXIT_UNAVAILABLE = 69;

const DEFAULT_PORT = 7717;

function readVersion(): string {
  try {
    const here = dirname(fileURLToPath(import.meta.url));
    const parsed: unknown = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8"));
    if (parsed && typeof parsed === "object" && "version" in parsed) {
      const { version } = parsed as { version?: unknown };
      if (typeof version === "string") return version;
    }
  } catch {
    /* fall through to the placeholder */
  }
  return "0.0.0";
}

const HELP = `portcullis, a firewall and flight recorder for AI tool calls

USAGE
  portcullis run [options] -- <command> [args...]
  portcullis tail [server] [options]
  portcullis serve [options]
  portcullis check <policy> [--against <json>]

COMMANDS
  run      Wrap an MCP server. Everything after -- is the server command,
           exactly as you would have written it in your agent's config.
  tail     Read the audit log in the terminal. With no server, lists what exists.
  serve    Open the web dashboard on localhost.
  check    Validate a policy file, or test one call against it.

RUN OPTIONS
  --name <name>        Label for this server, and the log filename.
                       Defaults to the command.
  --policy <file>      Enforce a policy. Without one, Portcullis only records.
  --ask-fallback <v>   What an ask verdict becomes while no approver is
                       connected: allow or deny. Overrides the policy file.
  --no-record          Pass traffic through without writing an audit log
  --max-payload <n>    Bytes of each payload to keep (default: ${DEFAULT_MAX_PAYLOAD_BYTES})
  --cwd <path>         Working directory for the wrapped server

TAIL OPTIONS
  -n <count>           Trailing records to show (default: 50, 0 for all)
  -f, --follow         Keep printing records as they arrive
  --json               Emit raw JSONL instead of the rendered view

CHECK OPTIONS
  --against <json>     Evaluate one call and print the verdict, instead of
                       only validating the file

SERVE OPTIONS
  --port <n>           Port to listen on (default: ${DEFAULT_PORT})
  --host <addr>        Address to bind (default: 127.0.0.1)

GLOBAL
  --log-level <level>  ${LOG_LEVELS.join(" | ")}   (default: info)
  --verbose            Shorthand for --log-level debug
  --quiet              Shorthand for --log-level error
  -h, --help           Show this help
  -v, --version        Show the version

EXAMPLE
  Wrap the filesystem server in your agent config:

    "filesystem": {
      "command": "portcullis",
      "args": ["run", "--name", "filesystem", "--",
               "npx", "-y", "@modelcontextprotocol/server-filesystem", "/home/me"]
    }

  Then look at what it did:

    portcullis tail filesystem
    portcullis serve

  Add enforcement once you have seen what it does:

    portcullis check fs.yaml
    portcullis run --policy fs.yaml --name filesystem -- ...

NOTES
  Diagnostics go to stderr. stdout carries protocol traffic and is never
  written to by Portcullis itself.

  Logs live under ~/.portcullis/logs and never leave the machine. The
  dashboard binds to localhost only.

  Documentation: https://github.com/Riverside1114/portcullis
`;

export async function main(argv: readonly string[]): Promise<number> {
  // Split our flags from the wrapped command first, so flags belonging to the
  // target server are never interpreted as ours.
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
        policy: { type: "string" },
        "ask-fallback": { type: "string" },
        against: { type: "string" },
        "no-record": { type: "boolean", default: false },
        "max-payload": { type: "string" },
        cwd: { type: "string" },
        port: { type: "string" },
        host: { type: "string" },
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

    case "check": {
      const path = positionals[1];
      if (path === undefined) {
        process.stderr.write("portcullis: check needs a policy file\n\n  portcullis check fs.yaml\n");
        return EXIT_USAGE;
      }
      return check({
        path,
        against: values.against,
        out: process.stdout,
        err: process.stderr,
        colour: process.stdout.isTTY === true,
      });
    }

    case "serve":
      return serve({
        port: parseCount(values.port, DEFAULT_PORT),
        host: values.host ?? "127.0.0.1",
        logger: createLogger({ level, scope: "serve" }),
      });

    default:
      process.stderr.write(`portcullis: unknown command "${subcommand}"\n\n${HELP}`);
      return EXIT_USAGE;
  }
}

interface RunContext {
  values: {
    name?: string | undefined;
    policy?: string | undefined;
    "ask-fallback"?: string | undefined;
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

  // Recording is best effort. A read-only home or a full disk degrades to a
  // plain passthrough rather than taking the agent's tooling down.
  const recorder = values["no-record"] ? null : await openRecorder(name, maxPayloadBytes, logger);
  const session = recorder ? new Session({ server: name, recorder, logger }) : undefined;

  if (recorder) logger.info(`recording to ${recorder.path}`);

  let policy: PolicyRuntime | undefined;
  if (values.policy !== undefined) {
    const fallback = values["ask-fallback"];
    if (fallback !== undefined && fallback !== "allow" && fallback !== "deny") {
      process.stderr.write("portcullis: --ask-fallback must be allow or deny\n");
      if (recorder) await recorder.close();
      return EXIT_USAGE;
    }

    try {
      const loaded = await loadPolicy(values.policy);
      policy = {
        engine: new PolicyEngine(loaded),
        askFallback: fallback ?? loaded.askFallback,
      };
      logger.info(
        `policy ${values.policy}: ${loaded.rules.length} rules, default ${loaded.default}`,
      );
    } catch (error) {
      // A policy that cannot be read has to stop the proxy. Starting without
      // the rules the user asked for would drop their protection at the exact
      // moment they believe it is on.
      if (error instanceof PolicyLoadError) {
        logger.error(error.message);
        if (recorder) await recorder.close();
        return EXIT_UNAVAILABLE;
      }
      throw error;
    }
  }

  try {
    const outcome = await runProxy({
      command,
      args: targetArgv.slice(1),
      logger,
      ...(values.cwd === undefined ? {} : { cwd: values.cwd }),
      ...(session === undefined ? {} : { session }),
      ...(policy === undefined ? {} : { policy }),
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

const invokedPath = process.argv[1];
if (invokedPath && import.meta.url === pathToFileURL(invokedPath).href) {
  void main(process.argv.slice(2)).then((code) => {
    // exitCode rather than process.exit(), which truncates piped output and for
    // a proxy would silently eat the tail of a protocol stream.
    process.exitCode = code;
  });
}
