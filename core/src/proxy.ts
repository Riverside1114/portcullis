import { spawn } from "node:child_process";
import { constants as osConstants } from "node:os";
import type { Logger } from "./logging.js";
import { createObserver } from "./observer.js";
import { createGate, denialResponse } from "./gate.js";
import type { JsonRpcId } from "./protocol.js";
import type { PolicyEngine } from "./policy/engine.js";
import type { Session } from "./session.js";

export interface PolicyRuntime {
  engine: PolicyEngine;
  /** What an ask verdict becomes while no approval front end is connected. */
  askFallback: "allow" | "deny";
}

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
  /** Omit to observe only. With a policy, calls can be refused. */
  policy?: PolicyRuntime;
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

    // Three wirings, in decreasing order of transparency.
    //
    // Neither session nor policy: the streams are joined directly and
    // Portcullis never holds a byte.
    //
    // Session only: an observer watches each direction and passes the original
    // bytes straight through, adding no buffering and no latency.
    //
    // Policy: both directions are reassembled into whole messages, because a
    // call cannot be judged from half of one, and because a denial must be
    // injected on a message boundary rather than into the middle of one.
    //
    // pipe() throughout rather than data handlers, so backpressure propagates.
    // A large tool result can outrun a slow consumer, and dropped bytes corrupt
    // the protocol stream. end:false on the outbound side, or ending the
    // child's stream would close the real process stdout underneath any later
    // shutdown message.
    let agentInSink: NodeJS.WritableStream = child.stdin;

    if (options.policy) {
      const { engine, askFallback } = options.policy;

      const outboundGate = createGate({
        observe: (line) => options.session?.observe("to-agent", line),
        onError: (error) => logger.warn("could not observe server traffic", error),
      });
      child.stdout.pipe(outboundGate);
      outboundGate.pipe(agentOut, { end: false });

      const refuse = (id: JsonRpcId, details: Parameters<typeof denialResponse>[1]): void => {
        const line = denialResponse(id, details);
        outboundGate.inject(line);
        options.session?.observe("to-agent", line);
      };

      const inboundGate = createGate({
        onError: (error) => logger.warn("policy evaluation failed", error),

        onOversize: (id) => {
          logger.error("a message was too large to evaluate and was refused");
          if (id !== undefined) {
            refuse(id, { reason: "message too large to evaluate against the policy" });
          }
        },

        decide: (message, text) => {
          const decision = engine.evaluate(message);

          let enforced: "allow" | "deny" =
            decision.verdict === "allow" ? "allow" : "deny";

          if (decision.verdict === "ask") {
            // The approval front end is a later milestone. Until it exists,
            // ask resolves to the configured fallback and says so loudly
            // rather than quietly picking one.
            enforced = askFallback;
            logger.warn(
              `rule "${decision.rule ?? "?"}" wants approval but no approver is connected, ` +
                `falling back to ${enforced}`,
            );
          }

          options.session?.observe("to-server", text, {
            verdict: decision.verdict,
            enforced,
            ...(decision.rule === undefined ? {} : { rule: decision.rule }),
            ...(decision.reason === undefined ? {} : { reason: decision.reason }),
            ...(decision.limited ? { limited: true } : {}),
          });

          if (enforced === "allow") return "forward";

          if (message.kind === "request") {
            logger.info(
              `denied ${message.method}${decision.rule ? ` by rule "${decision.rule}"` : ""}`,
            );
            refuse(message.id, {
              rule: decision.rule,
              reason: decision.reason,
              method: message.method,
              limited: decision.limited,
            });
          } else {
            // Only requests can be denied, so this is unreachable unless the
            // engine changes. Fail visible rather than dropping silently.
            logger.error(`policy tried to deny a ${message.kind}, which cannot be answered`);
            return "forward";
          }

          return "drop";
        },
      });

      inboundGate.pipe(child.stdin);
      agentIn.pipe(inboundGate);
      agentInSink = inboundGate;
    } else if (options.session) {
      const inbound = createObserver({
        onLine: (line) => options.session?.observe("to-server", line),
        onError: (error) => logger.warn("could not observe agent traffic", error),
      });
      const outbound = createObserver({
        onLine: (line) => options.session?.observe("to-agent", line),
        onError: (error) => logger.warn("could not observe server traffic", error),
      });

      inbound.pipe(child.stdin);
      agentIn.pipe(inbound);
      agentInSink = inbound;

      child.stdout.pipe(outbound);
      outbound.pipe(agentOut, { end: false });
    } else {
      agentIn.pipe(child.stdin);
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
