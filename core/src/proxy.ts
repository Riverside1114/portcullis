import { spawn } from "node:child_process";
import { constants as osConstants } from "node:os";
import type { Logger } from "./logging.js";
import { createObserver } from "./observer.js";
import type { Session } from "./session.js";

export interface ProxyStreams {
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  stderr?: NodeJS.WritableStream;
}

export interface ProxyOptions {
  command: string;
  args: readonly string[];
  logger: Logger;
  streams?: ProxyStreams;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  shutdownGraceMs?: number;
  /** Omit to run as a plain passthrough with no recording. */
  session?: Session;
}

export interface ProxyOutcome {
  code: number;
  signal: NodeJS.Signals | null;
}

const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] as const;

const DEFAULT_SHUTDOWN_GRACE_MS = 3_000;

/** A server that could not be started at all, as opposed to one that failed. */
export class ServerLaunchError extends Error {
  public readonly command: string;

  constructor(command: string, cause: NodeJS.ErrnoException) {
    const detail =
      cause.code === "ENOENT"
        ? `command not found: ${command}`
        : `${cause.code ?? "spawn failed"}: ${cause.message}`;
    super(`could not start MCP server, ${detail}`);
    this.name = "ServerLaunchError";
    this.command = command;
    this.cause = cause;
  }
}

export function runProxy(options: ProxyOptions): Promise<ProxyOutcome> {
  const {
    command,
    args,
    logger,
    streams = {},
    env = process.env,
    cwd,
    shutdownGraceMs = DEFAULT_SHUTDOWN_GRACE_MS,
  } = options;

  const agentIn = streams.stdin ?? process.stdin;
  const agentOut = streams.stdout ?? process.stdout;
  const agentErr = streams.stderr ?? process.stderr;

  return new Promise<ProxyOutcome>((resolve, reject) => {
    logger.info(`starting ${command} ${args.join(" ")}`.trim());

    const child = spawn(command, [...args], {
      stdio: ["pipe", "pipe", "pipe"],
      env,
      ...(cwd === undefined ? {} : { cwd }),
      windowsHide: true,
    });

    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    const signalHandlers = new Map<NodeJS.Signals, () => void>();

    const cleanup = (): void => {
      if (killTimer) clearTimeout(killTimer);
      for (const [signal, handler] of signalHandlers) {
        process.removeListener(signal, handler);
      }
      signalHandlers.clear();
    };

    child.on("error", (error: NodeJS.ErrnoException) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new ServerLaunchError(command, error));
    });

    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EPIPE") {
        logger.debug("server closed its input while the agent was still writing");
        return;
      }
      logger.warn("error writing to server input", error);
    });

    const inbound = options.session
      ? createObserver({
          onLine: (line) => options.session?.observe("to-server", line),
          onError: (error) => logger.warn("could not observe agent traffic", error),
        })
      : null;

    const outbound = options.session
      ? createObserver({
          onLine: (line) => options.session?.observe("to-agent", line),
          onError: (error) => logger.warn("could not observe server traffic", error),
        })
      : null;

    // pipe() rather than a data handler, so backpressure propagates. A large
    // tool result can outrun a slow consumer, and dropped bytes corrupt the
    // protocol stream.
    const agentInSink = inbound ?? child.stdin;
    if (inbound) inbound.pipe(child.stdin);
    agentIn.pipe(agentInSink);

    // end:false, or ending the child's stream would close the real process
    // stdout underneath any later shutdown message.
    if (outbound) {
      child.stdout.pipe(outbound);
      outbound.pipe(agentOut, { end: false });
    } else {
      child.stdout.pipe(agentOut, { end: false });
    }
    child.stderr.pipe(agentErr, { end: false });

    for (const signal of FORWARDED_SIGNALS) {
      const handler = (): void => {
        logger.debug(`forwarding ${signal} to server`);
        child.kill(signal);

        if (!killTimer) {
          killTimer = setTimeout(() => {
            if (child.exitCode === null && child.signalCode === null) {
              logger.warn(`server did not exit within ${shutdownGraceMs}ms, sending SIGKILL`);
              child.kill("SIGKILL");
            }
          }, shutdownGraceMs);
          killTimer.unref();
        }
      };

      try {
        process.on(signal, handler);
        signalHandlers.set(signal, handler);
      } catch {
        // Signal not supported on this platform.
      }
    }

    // "close" rather than "exit": it fires once the child's stdio is drained,
    // so nothing the server wrote is dropped on the way out.
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();

      agentIn.unpipe(agentInSink);
      if (agentIn === process.stdin) process.stdin.pause();

      for (const call of options.session?.unanswered() ?? []) {
        logger.warn(
          `server never answered ${call.method} (id ${String(call.id)}) after ${call.ageMs}ms`,
        );
      }

      const outcome: ProxyOutcome = { code: exitCodeFor(code, signal), signal };
      logger.info(
        signal
          ? `server terminated by ${signal} (reporting exit ${outcome.code})`
          : `server exited with code ${outcome.code}`,
      );
      resolve(outcome);
    });
  });
}

// Shell convention: killed by signal N reports 128 + N. The agent's supervisor
// may read this to decide whether to restart the server.
function exitCodeFor(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) return code;
  if (signal) {
    const signalNumber = osConstants.signals[signal];
    return typeof signalNumber === "number" ? 128 + signalNumber : 1;
  }
  return 0;
}
