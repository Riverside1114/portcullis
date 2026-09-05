import type { ClassifiedMessage } from "../protocol.js";
import { matchesAny } from "./pattern.js";
import type { Policy, Rule, Verdict } from "./schema.js";

export interface Decision {
  verdict: Verdict;
  /** Name of the rule that decided, absent when the default applied. */
  rule?: string;
  reason?: string;
  /** True when a rate limit produced the verdict rather than the rule's action. */
  limited?: boolean;
}

const ALLOWED: Decision = { verdict: "allow" };

export class PolicyEngine {
  readonly policy: Policy;
  readonly #now: () => number;
  readonly #calls = new Map<string, number[]>();

  constructor(policy: Policy, now: () => number = Date.now) {
    this.policy = policy;
    this.#now = now;
  }

  evaluate(message: ClassifiedMessage): Decision {
    // Only calls are gated. A response cannot be refused after the fact, and a
    // notification has no reply to carry a refusal.
    if (message.kind !== "request") return ALLOWED;

    const tool = toolNameOf(message);
    const args = argumentsOf(message);

    for (const rule of this.policy.rules) {
      if (!this.#matches(rule, message.method, tool, args)) continue;

      if (rule.limit) {
        const within = this.#recordAndCheck(rule);
        if (!within) {
          return {
            verdict: "deny",
            rule: rule.name,
            limited: true,
            reason: `rate limit reached: ${rule.limit.calls} calls per ${formatDuration(
              rule.limit.windowMs,
            )}`,
          };
        }
      }

      const decision: Decision = { verdict: rule.action, rule: rule.name };
      if (rule.reason !== undefined) decision.reason = rule.reason;
      return decision;
    }

    return { verdict: this.policy.default };
  }

  #matches(
    rule: Rule,
    method: string,
    tool: string | null,
    args: Record<string, unknown> | null,
  ): boolean {
    if (rule.method && !matchesAny(rule.method, method)) return false;

    if (rule.tool) {
      if (tool === null) return false;
      if (!matchesAny(rule.tool, tool)) return false;
    }

    if (rule.args) {
      if (args === null) return false;
      for (const matcher of rule.args) {
        const value = lookup(args, matcher.path);
        // An absent argument never matches, including against a negated
        // pattern. A rule that names an argument only applies to calls that
        // actually carry it.
        if (value === undefined) return false;
        if (!matchesAny(matcher.patterns, stringify(value))) return false;
      }
    }

    return true;
  }

  /** Sliding window. Only calls that reach the limit check are counted. */
  #recordAndCheck(rule: Rule): boolean {
    const limit = rule.limit as NonNullable<Rule["limit"]>;
    const now = this.#now();
    const cutoff = now - limit.windowMs;

    const seen = (this.#calls.get(rule.name) ?? []).filter((at) => at > cutoff);

    if (seen.length >= limit.calls) {
      this.#calls.set(rule.name, seen);
      return false;
    }

    seen.push(now);
    this.#calls.set(rule.name, seen);
    return true;
  }
}

function toolNameOf(message: ClassifiedMessage): string | null {
  if (message.kind !== "request") return null;
  const params = message.params;
  if (params === null || typeof params !== "object" || Array.isArray(params)) return null;
  const name = (params as Record<string, unknown>)["name"];
  return typeof name === "string" ? name : null;
}

// tools/call nests its arguments; other methods carry them directly on params.
// Both are searched so a policy author does not have to know which is which.
function argumentsOf(message: ClassifiedMessage): Record<string, unknown> | null {
  if (message.kind !== "request") return null;
  const params = message.params;
  if (params === null || typeof params !== "object" || Array.isArray(params)) return null;

  const map = params as Record<string, unknown>;
  const nested = map["arguments"];
  if (nested !== null && typeof nested === "object" && !Array.isArray(nested)) {
    return { ...map, ...(nested as Record<string, unknown>) };
  }
  return map;
}

export function lookup(root: Record<string, unknown>, path: string): unknown {
  let current: unknown = root;

  for (const segment of path.split(".")) {
    if (current === null || current === undefined) return undefined;

    if (Array.isArray(current)) {
      const index = Number.parseInt(segment, 10);
      if (!Number.isInteger(index)) return undefined;
      current = current[index];
      continue;
    }

    if (typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[segment];
  }

  return current;
}

function stringify(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value === null) return "null";
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

export function formatDuration(ms: number): string {
  if (ms % 3_600_000 === 0) return `${ms / 3_600_000}h`;
  if (ms % 60_000 === 0) return `${ms / 60_000}m`;
  if (ms % 1000 === 0) return `${ms / 1000}s`;
  return `${ms}ms`;
}
