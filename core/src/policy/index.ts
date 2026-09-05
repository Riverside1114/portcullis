import { readFile } from "node:fs/promises";
import { extname } from "node:path";
import { parseYaml, YamlError } from "./yaml.js";
import { compilePolicy, PolicyError } from "./schema.js";
import type { Policy } from "./schema.js";

export { PolicyEngine, lookup, formatDuration } from "./engine.js";
export type { Decision } from "./engine.js";
export { compilePolicy, PolicyError, parseDuration, POLICY_SCHEMA_VERSION } from "./schema.js";
export type { Policy, Rule, RateLimit, ArgMatcher, Verdict } from "./schema.js";
export { parseYaml, YamlError } from "./yaml.js";
export type { YamlValue, YamlMap } from "./yaml.js";
export { compilePattern, compilePatterns, matchesAny, PatternError } from "./pattern.js";
export type { Pattern } from "./pattern.js";

export class PolicyLoadError extends Error {
  readonly path: string;

  constructor(path: string, detail: string) {
    super(`${path}: ${detail}`);
    this.name = "PolicyLoadError";
    this.path = path;
  }
}

export async function loadPolicy(path: string): Promise<Policy> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (cause) {
    const code = (cause as NodeJS.ErrnoException).code;
    throw new PolicyLoadError(
      path,
      code === "ENOENT" ? "no such policy file" : `could not be read (${code ?? "unknown error"})`,
    );
  }

  return parsePolicy(text, path);
}

export function parsePolicy(text: string, path = "<policy>"): Policy {
  const asJson = extname(path).toLowerCase() === ".json" || text.trimStart().startsWith("{");

  let document;
  try {
    document = asJson ? JSON.parse(text) : parseYaml(text);
  } catch (cause) {
    if (cause instanceof YamlError) throw new PolicyLoadError(path, cause.message);
    throw new PolicyLoadError(path, `is not valid JSON (${(cause as Error).message})`);
  }

  try {
    return compilePolicy(document);
  } catch (cause) {
    if (cause instanceof PolicyError) throw new PolicyLoadError(path, cause.message);
    throw cause;
  }
}

/** One-line summary of a rule, for `portcullis check`. */
export function describeRule(rule: Policy["rules"][number]): string {
  const criteria: string[] = [];
  if (rule.method) criteria.push(`method ${rule.method.map((p) => p.source).join(" or ")}`);
  if (rule.tool) criteria.push(`tool ${rule.tool.map((p) => p.source).join(" or ")}`);
  if (rule.args) {
    for (const arg of rule.args) {
      criteria.push(`${arg.path} ${arg.patterns.map((p) => p.source).join(" or ")}`);
    }
  }
  if (rule.limit) criteria.push(`max ${rule.limit.calls} per ${rule.limit.windowMs / 1000}s`);

  return criteria.length === 0 ? "any call" : criteria.join(", ");
}
