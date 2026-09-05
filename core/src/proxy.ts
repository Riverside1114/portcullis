/**
 * The passthrough proxy (milestone M1).
 *
 * Portcullis launches the real MCP server as a child process and bridges the
 * agent's stdio to it. At this milestone it does not read the traffic — it only
 * has to carry it perfectly. The measure of success is that an agent cannot
 * tell Portcullis is there.
 *
 * That "cannot tell" bar is stricter than it sounds. It means byte-exact
 * forwarding in both directions, correct backpressure, signals reaching the
 * child, the child's exit code reaching the agent, and no truncated output when
 * things shut down. Milestone M2 replaces the direct pipes with a parsing
 * layer; every guarantee in this file has to survive that change.
 */

import { spawn } from "node:child_process";
import { constants as osConstants } from "node:os";
import type { Logger } from "./logging.js";
import { createObserver } from "./observer.js";
import type { Session } from "./session.js";

export interface ProxyStreams {
  /** Traffic arriving from the agent. Defaults to this process's stdin. */
  stdin?: NodeJS.ReadableStream;
  /** Traffic going back to the agent. Defaults to this process's stdout. */
  stdout?: NodeJS.WritableStream;
  /** Where the child's own diagnostics are forwarded. Defaults to stderr. */
  stderr?: NodeJS.WritableStream;
}

export interface ProxyOptions {
  /** Executable of the MCP server being wrapped. */
  command: string;
  /** Its arguments, passed through verbatim. */
  args: readonly string[];
  logger: Logger;
  streams?: ProxyStreams;
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  /** Grace period between SIGTERM and SIGKILL during shutdown. */
  shutdownGraceMs?: number;
  /**
   * When present, traffic is observed and recorded as it passes.
   *
   * Optional on purpose. A proxy with no session is exactly the M1 passthrough,
   * and that remains the fallback if recording ever cannot be set up — carrying
   * the traffic matters more than logging it.
   */
  session?: Session;
}

export interface ProxyOutcome {
  /** The exit code to propagate to whoever launched Portcullis. */
  code: number;
  /** The signal that killed the child, when it was killed by one. */
  signal: NodeJS.Signals | null;
}

/** Signals worth relaying to the child. Not all exist on every platform. */
const FORWARDED_SIGNALS = ["SIGINT", "SIGTERM", "SIGHUP", "SIGBREAK"] as const;

const DEFAULT_SHUTDOWN_GRACE_MS = 3_000;

/**
 * Thrown when the target server could not be started at all. This is distinct
 * from the server starting and then failing: a missing command is a
 * configuration mistake by the user, and deserves a message that says so.
 */
export class ServerLaunchError extends Error {
  public readonly command: string;

  constructor(command: string, cause: NodeJS.ErrnoException) {
    const detail =
      cause.code === "ENOENT"
        ? `command not found: ${command}`
        : `${cause.code ?? "spawn failed"}: ${cause.message}`;
    super(`could not start MCP server — ${detail}`);
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
      // Without this a wrapped server flashes a console window on Windows every
      // time an agent starts it.
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

    // ---- Wiring -----------------------------------------------------------
    // `pipe` is used deliberately: it propagates backpressure for free, which a
    // hand-rolled 'data' handler would not. An MCP server returning a large file
    // read can outrun a slow consumer, and dropping or reordering bytes there
    // corrupts the protocol stream.
    //
    // This is the seam M2 opens: the direct pipes become a transform that parses
    // frames on the way past. The end/error semantics below must not change.

    child.stdin.on("error", (error: NodeJS.ErrnoException) => {
      // The server exiting while the agent is mid-write is normal, not a fault.
      if (error.code === "EPIPE") {
        logger.debug("server closed its input while the agent was still writing");
        return;
      }
      logger.warn("error writing to server input", error);
    });

    // With a session, an observer is spliced into each direction. It passes the
    // original bytes through untouched and reports complete messages on the
    // side; without one, the streams are joined directly and this is the plain
    // M1 passthrough.
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

    // What the agent's input is piped into — the observer, or the child directly.
    const agentInSink = inbound ?? child.stdin;
    if (inbound) inbound.pipe(child.stdin);
    agentIn.pipe(agentInSink);

    // `end: false` because these are the real process streams. Ending them would
    // close the agent's channel out from under any later shutdown message.
    if (outbound) {
      child.stdout.pipe(outbound);
      outbound.pipe(agentOut, { end: false });
    } else {
      child.stdout.pipe(agentOut, { end: false });
    }

    // Server diagnostics are never protocol traffic, so they are forwarded raw.
    child.stderr.pipe(agentErr, { end: false });

    // ---- Signals ----------------------------------------------------------
    // The agent signals Portcullis; the server is what actually needs to stop.
    for (const signal of FORWARDED_SIGNALS) {
      const handler = (): void => {
        logger.debug(`forwarding ${signal} to server`);
        child.kill(signal);

        // A server that ignores a polite request still has to go.
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
        // Platform does not support this signal; nothing to forward.
      }
    }

    // ---- Exit -------------------------------------------------------------
    // 'close' rather than 'exit': it fires once the child's stdio has been fully
    // consumed, so nothing the server wrote is dropped on the way out.
    child.on("close", (code, signal) => {
      if (settled) return;
      settled = true;
      cleanup();

      // Stop pulling from the agent now that there is nowhere to put it.
      agentIn.unpipe(agentInSink);
      if (agentIn === process.stdin) process.stdin.pause();

      // Report calls the server accepted but never answered. An agent hides
      // this failure — the model simply waits forever — so the log is the only
      // place it becomes visible.
      const stranded = options.session?.unanswered() ?? [];
      for (const call of stranded) {
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

/**
 * Shell convention: a process killed by signal N reports 128 + N. Preserving
 * this matters because the agent's own supervisor may be reading the code to
 * decide whether to restart the server.
 */
function exitCodeFor(code: number | null, signal: NodeJS.Signals | null): number {
  if (code !== null) return code;
  if (signal) {
    const signalNumber = osConstants.signals[signal];
    return typeof signalNumber === "number" ? 128 + signalNumber : 1;
  }
  return 0;
}
