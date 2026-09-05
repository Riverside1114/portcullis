import { compilePatterns, PatternError, type Pattern } from "./pattern.js";
import type { YamlMap, YamlValue } from "./yaml.js";

export type Verdict = "allow" | "deny" | "ask";

const VERDICTS: readonly string[] = ["allow", "deny", "ask"];

export const POLICY_SCHEMA_VERSION = 1;

export interface RateLimit {
  calls: number;
  windowMs: number;
}

export interface ArgMatcher {
  path: string;
  patterns: Pattern[];
}

export interface Rule {
  name: string;
  action: Verdict;
  reason?: string;
  method?: Pattern[];
  tool?: Pattern[];
  args?: ArgMatcher[];
  limit?: RateLimit;
}

export interface Policy {
  version: number;
  default: Verdict;
  /** Used when a rule says ask but no approver is connected. */
  askFallback: "allow" | "deny";
  rules: Rule[];
}

export class PolicyError extends Error {
  readonly at: string;

  constructor(at: string, message: string) {
    super(at === "" ? message : `${at}: ${message}`);
    this.name = "PolicyError";
    this.at = at;
  }
}

const POLICY_KEYS = new Set(["version", "default", "ask_fallback", "rules"]);
const RULE_KEYS = new Set(["name", "action", "reason", "match", "limit"]);
const MATCH_KEYS = new Set(["method", "tool", "args"]);
const LIMIT_KEYS = new Set(["calls", "per"]);

export function compilePolicy(document: YamlValue): Policy {
  const root = expectMap(document, "");
  // Unknown keys are rejected everywhere. In a security config a typo such as
  // "tools:" for "tool:" would otherwise widen a rule silently.
  rejectUnknown(root, POLICY_KEYS, "");

  const version = root["version"];
  if (version === undefined || version === null) {
    throw new PolicyError("version", "is required, use: version: 1");
  }
  if (version !== POLICY_SCHEMA_VERSION) {
    throw new PolicyError("version", `unsupported version ${JSON.stringify(version)}, expected 1`);
  }

  const rulesValue = root["rules"];
  if (rulesValue !== undefined && rulesValue !== null && !Array.isArray(rulesValue)) {
    throw new PolicyError("rules", "must be a list");
  }
  const rawRules = (rulesValue ?? []) as YamlValue[];

  const names = new Set<string>();
  const rules = rawRules.map((raw, index) => {
    const rule = compileRule(raw, `rules[${index}]`);
    if (names.has(rule.name)) {
      throw new PolicyError(`rules[${index}].name`, `duplicate rule name ${JSON.stringify(rule.name)}`);
    }
    names.add(rule.name);
    return rule;
  });

  return {
    version: POLICY_SCHEMA_VERSION,
    default: expectVerdict(root["default"] ?? "allow", "default"),
    askFallback: expectFallback(root["ask_fallback"] ?? "deny"),
    rules,
  };
}

function compileRule(raw: YamlValue, at: string): Rule {
  const map = expectMap(raw, at);
  rejectUnknown(map, RULE_KEYS, at);

  const name = map["name"];
  if (typeof name !== "string" || name.trim() === "") {
    throw new PolicyError(`${at}.name`, "is required and must be a non-empty string");
  }

  const action = map["action"];
  if (action === undefined || action === null) {
    throw new PolicyError(`${at}.action`, `is required, one of ${VERDICTS.join(", ")}`);
  }

  const rule: Rule = {
    name,
    action: expectVerdict(action, `${at}.action`),
  };

  const reason = map["reason"];
  if (reason !== undefined && reason !== null) {
    if (typeof reason !== "string") throw new PolicyError(`${at}.reason`, "must be a string");
    rule.reason = reason;
  }

  const match = map["match"];
  if (match !== undefined && match !== null) {
    const matchMap = expectMap(match, `${at}.match`);
    rejectUnknown(matchMap, MATCH_KEYS, `${at}.match`);

    if (matchMap["method"] !== undefined && matchMap["method"] !== null) {
      rule.method = patternsAt(matchMap["method"], `${at}.match.method`);
    }
    if (matchMap["tool"] !== undefined && matchMap["tool"] !== null) {
      rule.tool = patternsAt(matchMap["tool"], `${at}.match.tool`);
    }
    if (matchMap["args"] !== undefined && matchMap["args"] !== null) {
      const argsMap = expectMap(matchMap["args"], `${at}.match.args`);
      rule.args = Object.entries(argsMap).map(([path, value]) => ({
        path,
        patterns: patternsAt(value, `${at}.match.args.${path}`),
      }));
      if (rule.args.length === 0) {
        throw new PolicyError(`${at}.match.args`, "must name at least one argument");
      }
    }
  }

  const limit = map["limit"];
  if (limit !== undefined && limit !== null) {
    rule.limit = compileLimit(limit, `${at}.limit`);
  }

  if (!rule.method && !rule.tool && !rule.args && !rule.limit) {
    // A rule with no criteria matches everything. That is almost never what
    // someone meant, and as a deny rule it would block the whole server.
    throw new PolicyError(
      at,
      "has no match criteria and no limit, so it would apply to every call. " +
        "Add a match block, or set the policy default instead.",
    );
  }

  return rule;
}

function compileLimit(raw: YamlValue, at: string): RateLimit {
  const map = expectMap(raw, at);
  rejectUnknown(map, LIMIT_KEYS, at);

  const calls = map["calls"];
  if (typeof calls !== "number" || !Number.isInteger(calls) || calls < 1) {
    throw new PolicyError(`${at}.calls`, "must be a positive whole number");
  }

  return { calls, windowMs: parseDuration(map["per"], `${at}.per`) };
}

/** Accepts 30, "30s", "5m", "1h". A bare number is read as seconds. */
export function parseDuration(raw: YamlValue | undefined, at: string): number {
  if (typeof raw === "number") {
    if (raw <= 0) throw new PolicyError(at, "must be greater than zero");
    return raw * 1000;
  }

  if (typeof raw !== "string") {
    throw new PolicyError(at, 'is required, for example "60s", "5m" or "1h"');
  }

  const match = /^(\d+(?:\.\d+)?)\s*(ms|s|m|h)?$/.exec(raw.trim());
  if (!match) {
    throw new PolicyError(at, `could not read ${JSON.stringify(raw)} as a duration`);
  }

  const amount = Number.parseFloat(match[1] as string);
  if (amount <= 0) throw new PolicyError(at, "must be greater than zero");

  const scale: Record<string, number> = { ms: 1, s: 1000, m: 60_000, h: 3_600_000 };
  return Math.round(amount * (scale[match[2] ?? "s"] as number));
}

function patternsAt(raw: YamlValue, at: string): Pattern[] {
  const list = Array.isArray(raw) ? raw : [raw];
  if (list.length === 0) throw new PolicyError(at, "must not be empty");

  return list.map((entry, index) => {
    if (typeof entry !== "string") {
      throw new PolicyError(`${at}[${index}]`, "must be a string pattern");
    }
    try {
      return compilePatterns([entry])[0] as Pattern;
    } catch (cause) {
      if (cause instanceof PatternError) throw new PolicyError(`${at}[${index}]`, cause.message);
      throw cause;
    }
  });
}

function expectFallback(raw: YamlValue): "allow" | "deny" {
  const verdict = expectVerdict(raw, "ask_fallback");
  if (verdict === "ask") {
    throw new PolicyError("ask_fallback", "must be allow or deny, since it is what ask becomes");
  }
  return verdict;
}

function expectVerdict(raw: YamlValue, at: string): Verdict {
  if (typeof raw !== "string" || !VERDICTS.includes(raw)) {
    throw new PolicyError(
      at,
      `must be one of ${VERDICTS.join(", ")}, found ${JSON.stringify(raw)}`,
    );
  }
  return raw as Verdict;
}

function expectMap(raw: YamlValue, at: string): YamlMap {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new PolicyError(at, `must be a mapping, found ${describe(raw)}`);
  }
  return raw;
}

function rejectUnknown(map: YamlMap, allowed: Set<string>, at: string): void {
  for (const key of Object.keys(map)) {
    if (allowed.has(key)) continue;
    const suggestion = closest(key, [...allowed]);
    throw new PolicyError(
      at === "" ? key : `${at}.${key}`,
      `unknown setting${suggestion ? `, did you mean ${JSON.stringify(suggestion)}?` : ""}`,
    );
  }
}

function describe(value: YamlValue): string {
  if (value === null) return "nothing";
  if (Array.isArray(value)) return "a list";
  return typeof value;
}

/** Cheap nearest-name suggestion, good enough for catching a typo. */
function closest(input: string, candidates: string[]): string | null {
  let best: string | null = null;
  let bestScore = Number.POSITIVE_INFINITY;

  for (const candidate of candidates) {
    const score = distance(input, candidate);
    if (score < bestScore) {
      bestScore = score;
      best = candidate;
    }
  }

  return bestScore <= Math.max(2, Math.floor(input.length / 3)) ? best : null;
}

function distance(a: string, b: string): number {
  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);

  for (let i = 1; i <= a.length; i += 1) {
    const current = [i];
    for (let j = 1; j <= b.length; j += 1) {
      const substitution = (previous[j - 1] as number) + (a[i - 1] === b[j - 1] ? 0 : 1);
      const deletion = (previous[j] as number) + 1;
      const insertion = (current[j - 1] as number) + 1;
      current.push(Math.min(substitution, deletion, insertion));
    }
    previous = current;
  }

  return previous[b.length] as number;
}
