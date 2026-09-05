/**
 * Policy parsing, matching and evaluation.
 *
 * These carry more weight than the rest of the suite. Everywhere else a bug
 * costs a wrong log line; here a bug means a call the user believed was blocked
 * went through.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseYaml,
  YamlError,
  compilePattern,
  matchesAny,
  compilePolicy,
  parsePolicy,
  PolicyError,
  PolicyLoadError,
  PolicyEngine,
  parseDuration,
  classify,
} from "../dist/index.js";

const call = (method, params) =>
  classify(JSON.stringify({ jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) }));

const toolCall = (name, args) => call("tools/call", { name, arguments: args });

// ---------------------------------------------------------------- patterns

test("a glob star does not cross a path separator", () => {
  const pattern = compilePattern("/home/*/notes.txt");
  assert.ok(pattern.test("/home/me/notes.txt"));
  assert.ok(!pattern.test("/home/me/deep/notes.txt"));
});

test("a globstar crosses separators and collapses to nothing", () => {
  const pattern = compilePattern("src/**/index.ts");
  assert.ok(pattern.test("src/index.ts"), "a/**/b must also match a/b");
  assert.ok(pattern.test("src/a/index.ts"));
  assert.ok(pattern.test("src/a/b/c/index.ts"));
  assert.ok(!pattern.test("lib/index.ts"));
});

test("an absolute path is a glob, not a regex", () => {
  // Both forms start with a slash. Reading /home/me/** as a regex produced a
  // flags error and made the example policies unloadable.
  const pattern = compilePattern("/home/me/project/**");
  assert.ok(pattern.test("/home/me/project/src/index.ts"));
  assert.ok(!pattern.test("/etc/hosts"));
});

test("regexes are marked with a prefix, with or without flags", () => {
  assert.ok(compilePattern("re:^tools/").test("tools/call"));
  assert.ok(compilePattern("re:/^TOOLS/i").test("tools/call"));
  assert.ok(!compilePattern("re:^tools/").test("resources/read"));
});

test("negation inverts either form", () => {
  const glob = compilePattern("!/home/me/**");
  assert.ok(glob.negated);
  assert.ok(glob.test("/etc/hosts"));
  assert.ok(!glob.test("/home/me/x"));

  assert.ok(compilePattern("!re:^tools/").test("resources/read"));
});

test("braces and character classes", () => {
  assert.ok(compilePattern("**/*.{pem,key}").test("a/b/server.pem"));
  assert.ok(compilePattern("**/*.{pem,key}").test("a/b/server.key"));
  assert.ok(!compilePattern("**/*.{pem,key}").test("a/b/server.txt"));

  assert.ok(compilePattern("id_[re]sa").test("id_rsa"));
  assert.ok(!compilePattern("id_[!re]sa").test("id_rsa"));
});

test("a list matches if any positive matches and every negative passes", () => {
  const patterns = ["**/*.ts", "**/*.js"].map(compilePattern);
  assert.ok(matchesAny(patterns, "a/b.ts"));
  assert.ok(!matchesAny(patterns, "a/b.py"));

  // A negative alone means "anything except this".
  const excluded = [compilePattern("!/home/me/**")];
  assert.ok(matchesAny(excluded, "/etc/hosts"));
  assert.ok(!matchesAny(excluded, "/home/me/x"));
});

// -------------------------------------------------------------------- yaml

test("parses nested maps, lists and lists of maps", () => {
  const value = parseYaml(`
version: 1
default: allow
rules:
  - name: first
    action: deny
    match:
      tool: write_file
      args:
        path: "/etc/**"
  - name: second
    action: allow
    match:
      method: [tools/list, ping]
`);

  assert.equal(value.version, 1);
  assert.equal(value.rules.length, 2);
  assert.equal(value.rules[0].match.args.path, "/etc/**");
  assert.deepEqual(value.rules[1].match.method, ["tools/list", "ping"]);
});

test("reads scalars as their types", () => {
  const value = parseYaml("a: 1\nb: 1.5\nc: true\nd: false\ne: null\nf: ~\ng: text\nh: '5'");
  assert.equal(value.a, 1);
  assert.equal(value.b, 1.5);
  assert.equal(value.c, true);
  assert.equal(value.d, false);
  assert.equal(value.e, null);
  assert.equal(value.f, null);
  assert.equal(value.g, "text");
  assert.equal(value.h, "5", "a quoted number stays a string");
});

test("strips comments but not a hash inside a quoted string", () => {
  const value = parseYaml('a: 1 # trailing\n# whole line\nb: "has # inside"');
  assert.equal(value.a, 1);
  assert.equal(value.b, "has # inside");
});

test("rejects what it does not support, naming the line", () => {
  const cases = [
    ["a: &anchor 1", /anchors/],
    ["a: |\n  block", /block scalars/],
    ["a: {inline: 1}", /inline maps/],
    ["a: 1\na: 2", /duplicate key/],
    ["---\na: 1", /multiple documents/],
  ];

  for (const [source, expected] of cases) {
    assert.throws(() => parseYaml(source), (error) => {
      assert.ok(error instanceof YamlError, `${source} threw ${error}`);
      assert.match(error.message, expected);
      assert.match(error.message, /^line \d+:/);
      return true;
    });
  }
});

test("rejects a tab used for indentation", () => {
  assert.throws(() => parseYaml("a:\n\tb: 1"), /tabs/);
});

// ------------------------------------------------------------------ schema

const MINIMAL = `
version: 1
rules:
  - name: no env
    action: deny
    match:
      args:
        path: "**/.env"
`;

test("compiles a minimal policy with sensible defaults", () => {
  const policy = parsePolicy(MINIMAL);
  assert.equal(policy.default, "allow");
  assert.equal(policy.askFallback, "deny");
  assert.equal(policy.rules.length, 1);
});

test("rejects an unknown setting and suggests the right one", () => {
  // The reason this matters: "tools:" for "tool:" would otherwise be ignored,
  // and the rule would match far more than intended.
  assert.throws(
    () => parsePolicy("version: 1\nrules:\n  - name: x\n    action: deny\n    match:\n      tools: read_file\n"),
    (error) => {
      assert.ok(error instanceof PolicyLoadError);
      assert.match(error.message, /unknown setting/);
      assert.match(error.message, /did you mean "tool"/);
      return true;
    },
  );
});

test("rejects a rule that would match every call", () => {
  assert.throws(
    () => parsePolicy("version: 1\nrules:\n  - name: everything\n    action: deny\n"),
    /would apply to every call/,
  );
});

test("rejects missing or wrong core fields", () => {
  assert.throws(() => parsePolicy("rules: []\n"), /version.*required/s);
  assert.throws(() => parsePolicy("version: 2\n"), /unsupported version/);
  assert.throws(
    () => parsePolicy("version: 1\nrules:\n  - action: deny\n    match:\n      tool: x\n"),
    /name.*required/s,
  );
  assert.throws(
    () => parsePolicy("version: 1\nrules:\n  - name: x\n    action: maybe\n    match:\n      tool: y\n"),
    /must be one of allow, deny, ask/,
  );
});

test("rejects duplicate rule names", () => {
  assert.throws(
    () =>
      parsePolicy(
        "version: 1\nrules:\n  - name: x\n    action: deny\n    match:\n      tool: a\n" +
          "  - name: x\n    action: allow\n    match:\n      tool: b\n",
      ),
    /duplicate rule name/,
  );
});

test("rejects an ask fallback of ask, which would be circular", () => {
  assert.throws(() => parsePolicy("version: 1\nask_fallback: ask\nrules: []\n"), /must be allow or deny/);
});

test("reads durations", () => {
  assert.equal(parseDuration(30, "at"), 30_000);
  assert.equal(parseDuration("500ms", "at"), 500);
  assert.equal(parseDuration("90s", "at"), 90_000);
  assert.equal(parseDuration("5m", "at"), 300_000);
  assert.equal(parseDuration("2h", "at"), 7_200_000);
  assert.throws(() => parseDuration("soon", "at"), PolicyError);
  assert.throws(() => parseDuration(0, "at"), /greater than zero/);
});

test("accepts a policy written as JSON", () => {
  const policy = parsePolicy(
    JSON.stringify({
      version: 1,
      default: "deny",
      rules: [{ name: "reads", action: "allow", match: { tool: "read_*" } }],
    }),
    "policy.json",
  );
  assert.equal(policy.default, "deny");
  assert.equal(policy.rules.length, 1);
});

// ------------------------------------------------------------------ engine

function engineFor(source, now) {
  return new PolicyEngine(parsePolicy(source), now);
}

test("the first matching rule decides", () => {
  const engine = engineFor(`
version: 1
default: allow
rules:
  - name: allow project reads
    action: allow
    match:
      args:
        path: "/home/me/project/**"
  - name: deny all reads
    action: deny
    match:
      tool: read_file
`);

  assert.equal(engine.evaluate(toolCall("read_file", { path: "/home/me/project/a.ts" })).rule, "allow project reads");
  assert.equal(engine.evaluate(toolCall("read_file", { path: "/etc/hosts" })).verdict, "deny");
});

test("an unmatched call falls through to the default", () => {
  const engine = engineFor("version: 1\ndefault: deny\nrules: []\n");
  const decision = engine.evaluate(toolCall("anything", {}));
  assert.equal(decision.verdict, "deny");
  assert.equal(decision.rule, undefined);
});

test("an absent argument never matches, even a negated pattern", () => {
  // Otherwise a rule saying "path outside the project" would fire on calls
  // that carry no path at all, which is action at a distance.
  const engine = engineFor(`
version: 1
default: allow
rules:
  - name: writes stay home
    action: deny
    match:
      args:
        path: "!/home/me/**"
`);

  assert.equal(engine.evaluate(toolCall("write_file", { path: "/etc/hosts" })).verdict, "deny");
  assert.equal(engine.evaluate(toolCall("write_file", { path: "/home/me/x" })).verdict, "allow");
  assert.equal(engine.evaluate(toolCall("list_tools", {})).verdict, "allow");
});

test("a tool rule does not fire on a call with no tool name", () => {
  const engine = engineFor(
    "version: 1\ndefault: allow\nrules:\n  - name: no writes\n    action: deny\n    match:\n      tool: write_file\n",
  );
  assert.equal(engine.evaluate(call("tools/list")).verdict, "allow");
  assert.equal(engine.evaluate(toolCall("write_file", {})).verdict, "deny");
});

test("only requests are judged", () => {
  const engine = engineFor("version: 1\ndefault: deny\nrules: []\n");

  for (const line of [
    '{"jsonrpc":"2.0","method":"notifications/initialized"}',
    '{"jsonrpc":"2.0","id":1,"result":{}}',
    '{"jsonrpc":"2.0","id":1,"error":{"code":-1,"message":"x"}}',
    "not json at all",
  ]) {
    assert.equal(engine.evaluate(classify(line)).verdict, "allow", line);
  }
});

test("nested argument paths are addressable", () => {
  const engine = engineFor(`
version: 1
default: allow
rules:
  - name: no prod
    action: deny
    match:
      args:
        target.environment: prod
`);

  assert.equal(engine.evaluate(toolCall("deploy", { target: { environment: "prod" } })).verdict, "deny");
  assert.equal(engine.evaluate(toolCall("deploy", { target: { environment: "dev" } })).verdict, "allow");
});

test("a rate limit denies past the ceiling and recovers after the window", () => {
  let now = 1_000_000;
  const engine = engineFor(
    "version: 1\ndefault: allow\nrules:\n  - name: capped\n    action: allow\n    match:\n      tool: fetch\n    limit:\n      calls: 2\n      per: 60s\n",
    () => now,
  );

  assert.equal(engine.evaluate(toolCall("fetch", {})).verdict, "allow");
  assert.equal(engine.evaluate(toolCall("fetch", {})).verdict, "allow");

  const third = engine.evaluate(toolCall("fetch", {}));
  assert.equal(third.verdict, "deny");
  assert.equal(third.limited, true);
  assert.match(third.reason, /rate limit/);

  // The window slides rather than resetting on a fixed boundary.
  now += 61_000;
  assert.equal(engine.evaluate(toolCall("fetch", {})).verdict, "allow");
});

test("a rate limit only counts the calls that reach it", () => {
  let now = 0;
  const engine = engineFor(
    "version: 1\ndefault: allow\nrules:\n  - name: capped\n    action: allow\n    match:\n      tool: fetch\n    limit:\n      calls: 1\n      per: 60s\n",
    () => now,
  );

  engine.evaluate(toolCall("other", {}));
  engine.evaluate(toolCall("other", {}));
  assert.equal(engine.evaluate(toolCall("fetch", {})).verdict, "allow");
  assert.equal(engine.evaluate(toolCall("fetch", {})).verdict, "deny");
});

test("the shipped example policies are valid", async () => {
  const { loadPolicy } = await import("../dist/index.js");
  for (const name of ["filesystem.yaml", "read-only.yaml"]) {
    const policy = await loadPolicy(new URL(`../../examples/policies/${name}`, import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"));
    assert.ok(policy.rules.length > 0, `${name} has no rules`);
  }
});
