import { classify } from "../protocol.js";
import { loadPolicy, PolicyLoadError, PolicyEngine, describeRule } from "../policy/index.js";

export interface CheckOptions {
  path: string;
  /** A JSON-RPC request to evaluate against the policy, as JSON text. */
  against?: string | undefined;
  out: NodeJS.WritableStream;
  err: NodeJS.WritableStream;
  colour?: boolean;
}

const ANSI = {
  reset: "[0m",
  dim: "[2m",
  bold: "[1m",
  red: "[31m",
  green: "[32m",
  yellow: "[33m",
};

export async function check(options: CheckOptions): Promise<number> {
  const paint = (code: string, text: string): string =>
    options.colour ? `${code}${text}${ANSI.reset}` : text;

  let policy;
  try {
    policy = await loadPolicy(options.path);
  } catch (error) {
    if (error instanceof PolicyLoadError) {
      options.err.write(`${paint(ANSI.red, "invalid policy")} ${error.message}\n`);
      return 1;
    }
    throw error;
  }

  if (options.against !== undefined) {
    return explain(policy, options, paint);
  }

  options.out.write(`${paint(ANSI.green, "valid")} ${options.path}\n\n`);
  options.out.write(`  default        ${policy.default}\n`);
  options.out.write(`  ask fallback   ${policy.askFallback}\n\n`);

  if (policy.rules.length === 0) {
    options.out.write(`  ${paint(ANSI.yellow, "no rules")}, every call falls through to the default\n`);
    return 0;
  }

  const width = Math.max(...policy.rules.map((rule) => rule.name.length));
  policy.rules.forEach((rule, index) => {
    const colour =
      rule.action === "deny" ? ANSI.red : rule.action === "ask" ? ANSI.yellow : ANSI.green;
    options.out.write(
      `  ${String(index + 1).padStart(2)}. ${rule.name.padEnd(width)}  ` +
        `${paint(colour, rule.action.padEnd(5))}  ${paint(ANSI.dim, describeRule(rule))}\n`,
    );
  });

  const plural = policy.rules.length === 1 ? "rule" : "rules";
  options.out.write(`\n${policy.rules.length} ${plural}, evaluated in order, first match wins.\n`);
  return 0;
}

function explain(
  policy: Awaited<ReturnType<typeof loadPolicy>>,
  options: CheckOptions,
  paint: (code: string, text: string) => string,
): number {
  const text = options.against as string;

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    options.err.write(`portcullis: --against is not valid JSON (${(cause as Error).message})\n`);
    return 64;
  }

  // Accept a bare call such as {"method":"tools/call","params":{...}} and fill
  // in the envelope, so a policy can be tested without writing boilerplate.
  const envelope = parsed as Record<string, unknown>;
  const request = {
    jsonrpc: "2.0",
    id: envelope["id"] ?? 1,
    method: envelope["method"],
    ...(envelope["params"] === undefined ? {} : { params: envelope["params"] }),
  };

  if (typeof request.method !== "string") {
    options.err.write('portcullis: --against needs a "method", for example {"method":"tools/list"}\n');
    return 64;
  }

  const message = classify(JSON.stringify(request));
  const decision = new PolicyEngine(policy).evaluate(message);

  const colour =
    decision.verdict === "deny" ? ANSI.red : decision.verdict === "ask" ? ANSI.yellow : ANSI.green;

  let line = paint(colour, paint(ANSI.bold, decision.verdict));
  line += decision.rule ? ` by rule "${decision.rule}"` : " by the policy default";
  if (decision.reason) line += `: ${decision.reason}`;
  if (decision.limited) line += " (rate limit)";

  options.out.write(`${line}\n`);

  if (decision.verdict === "ask") {
    options.out.write(
      paint(
        ANSI.dim,
        `while no approver is connected this resolves to ${policy.askFallback}\n`,
      ),
    );
  }

  return decision.verdict === "deny" ? 1 : 0;
}
