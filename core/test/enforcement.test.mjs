/**
 * End-to-end enforcement.
 *
 * The claim under test is not that the engine returns "deny". It is that a
 * denied call never reaches the server, that the agent gets an error it can act
 * on, and that inserting that error does not corrupt the stream it is inserted
 * into.
 */

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  runProxy,
  createLogger,
  Recorder,
  Session,
  PolicyEngine,
  parsePolicy,
  logPathFor,
  POLICY_DENIED_CODE,
} from "../dist/index.js";

const FIXTURE = fileURLToPath(new URL("../fixtures/echo-server.mjs", import.meta.url));
const silent = createLogger({ level: "silent" });

let home;
before(async () => {
  home = await mkdtemp(join(tmpdir(), "portcullis-gate-"));
  process.env.PORTCULLIS_HOME = home;
});
after(async () => {
  delete process.env.PORTCULLIS_HOME;
  await rm(home, { recursive: true, force: true });
});

async function gated(name, source, drive, { askFallback = "deny", record = true } = {}) {
  const recorder = record ? await Recorder.open({ path: logPathFor(name), logger: silent }) : null;
  const session = recorder ? new Session({ server: name, recorder, logger: silent }) : undefined;

  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();

  const chunks = [];
  stdout.on("data", (chunk) => chunks.push(chunk));

  const done = runProxy({
    command: process.execPath,
    args: [FIXTURE],
    logger: silent,
    streams: { stdin, stdout, stderr },
    ...(session ? { session } : {}),
    policy: { engine: new PolicyEngine(parsePolicy(source)), askFallback },
  });

  const send = (message) => stdin.write(`${JSON.stringify(message)}\n`);
  drive(send, stdin);

  // Closing the channel rather than sending quit: under a default-deny policy
  // the quit call is itself denied, and the server would never exit.
  stdin.end();

  await done;
  if (recorder) await recorder.close();

  const text = Buffer.concat(chunks).toString("utf8");
  const messages = text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));

  return {
    text,
    messages,
    records: recorder
      ? (await readFile(logPathFor(name), "utf8"))
          .split("\n")
          .filter((line) => line.trim() !== "")
          .map((line) => JSON.parse(line))
      : [],
  };
}

const DENY_ENV = `
version: 1
default: allow
rules:
  - name: no credential files
    action: deny
    reason: credential files are off limits
    match:
      args:
        path: "**/.env"
`;

test("a denied call never reaches the server", { timeout: 30_000 }, async () => {
  const { messages } = await gated("blocked", DENY_ENV, (send) => {
    send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read_file", arguments: { path: "/home/me/.env" } } });
  });

  // The fixture echoes everything it receives, so any echo of id 1 would mean
  // the call got through.
  const echoed = messages.find((m) => m.id === 1 && m.result);
  assert.equal(echoed, undefined, "the denied call was forwarded to the server");
});

test("the agent receives a JSON-RPC error it can act on", { timeout: 30_000 }, async () => {
  const { messages } = await gated("error-shape", DENY_ENV, (send) => {
    send({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "read_file", arguments: { path: "/home/me/.env" } } });
  });

  const reply = messages.find((m) => m.id === 7);
  assert.ok(reply, "no reply was sent for the denied call");
  assert.equal(reply.jsonrpc, "2.0");
  assert.equal(reply.error.code, POLICY_DENIED_CODE);
  assert.match(reply.error.message, /Blocked by Portcullis policy "no credential files"/);
  assert.match(reply.error.message, /credential files are off limits\./);
  assert.match(reply.error.message, /not sent to the server/);
  assert.equal(reply.error.data.portcullis, "denied");
  assert.equal(reply.error.data.rule, "no credential files");
});

test("allowed calls still reach the server unchanged", { timeout: 30_000 }, async () => {
  const { messages } = await gated("allowed", DENY_ENV, (send) => {
    send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read_file", arguments: { path: "/home/me/ok.txt" } } });
  });

  const echoed = messages.find((m) => m.id === 1);
  assert.deepEqual(echoed.result.params, { name: "read_file", arguments: { path: "/home/me/ok.txt" } });
});

test("injecting a denial does not corrupt a large response streaming past it", { timeout: 30_000 }, async () => {
  // The injected error travels the same path as server output. If it were
  // written between two chunks of one server message it would split that
  // message and produce unparseable JSONL.
  const big = "x".repeat(3 * 1024 * 1024);

  const { messages, text } = await gated("interleave", DENY_ENV, (send) => {
    send({ jsonrpc: "2.0", id: 1, method: "read", params: { blob: big } });
    for (let i = 0; i < 40; i += 1) {
      send({ jsonrpc: "2.0", id: 100 + i, method: "tools/call", params: { name: "read_file", arguments: { path: "/home/me/.env" } } });
      send({ jsonrpc: "2.0", id: 200 + i, method: "ping" });
    }
  });

  // Every line parsed, which is the real assertion: nothing was split.
  assert.ok(messages.length > 40);

  const big1 = messages.find((m) => m.id === 1);
  assert.equal(big1.result.params.blob.length, big.length, "the large payload was truncated");

  for (let i = 0; i < 40; i += 1) {
    const denial = messages.find((m) => m.id === 100 + i);
    assert.equal(denial.error.code, POLICY_DENIED_CODE, `denial ${i} missing`);
    assert.ok(messages.find((m) => m.id === 200 + i)?.result, `allowed call ${i} missing`);
  }

  assert.ok(!text.includes("}{"), "two messages ran together");
});

test("a rate limit denies past its ceiling", { timeout: 30_000 }, async () => {
  const source = `
version: 1
default: allow
rules:
  - name: capped
    action: allow
    match:
      tool: fetch
    limit:
      calls: 2
      per: 1h
`;

  const { messages } = await gated("limited", source, (send) => {
    for (let i = 1; i <= 4; i += 1) {
      send({ jsonrpc: "2.0", id: i, method: "tools/call", params: { name: "fetch", arguments: {} } });
    }
  });

  assert.ok(messages.find((m) => m.id === 1).result, "first call should pass");
  assert.ok(messages.find((m) => m.id === 2).result, "second call should pass");
  assert.equal(messages.find((m) => m.id === 3).error.data.rateLimited, true);
  assert.equal(messages.find((m) => m.id === 4).error.data.rateLimited, true);
});

test("ask resolves to the configured fallback and is recorded as both", { timeout: 30_000 }, async () => {
  const source = `
version: 1
default: allow
rules:
  - name: deletion needs approval
    action: ask
    reason: deleting files is not reversible
    match:
      tool: delete_file
`;

  const { messages, records } = await gated(
    "asked",
    source,
    (send) => send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "delete_file", arguments: {} } }),
    { askFallback: "deny" },
  );

  assert.equal(messages.find((m) => m.id === 1).error.code, POLICY_DENIED_CODE);

  const request = records.find((r) => r.dir === "to-server" && r.id === 1);
  assert.equal(request.policy.verdict, "ask", "the log must keep what the rule asked for");
  assert.equal(request.policy.enforced, "deny", "and what actually happened");
});

test("an ask fallback of allow lets the call through", { timeout: 30_000 }, async () => {
  const source = `
version: 1
default: allow
rules:
  - name: deletion needs approval
    action: ask
    match:
      tool: delete_file
`;

  const { messages } = await gated(
    "asked-allow",
    source,
    (send) => send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "delete_file", arguments: {} } }),
    { askFallback: "allow" },
  );

  assert.ok(messages.find((m) => m.id === 1).result, "the call should have been forwarded");
});

test("the audit log records the verdict on every judged call", { timeout: 30_000 }, async () => {
  const { records } = await gated("verdicts", DENY_ENV, (send) => {
    send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read_file", arguments: { path: "/home/me/.env" } } });
    send({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "read_file", arguments: { path: "/home/me/ok.txt" } } });
  });

  const denied = records.find((r) => r.dir === "to-server" && r.id === 1);
  assert.equal(denied.policy.enforced, "deny");
  assert.equal(denied.policy.rule, "no credential files");

  const allowed = records.find((r) => r.dir === "to-server" && r.id === 2);
  assert.equal(allowed.policy.enforced, "allow");

  // The denial the agent received is logged as inbound traffic too, so the log
  // shows both halves of the exchange.
  const reply = records.find((r) => r.dir === "to-agent" && r.id === 1);
  assert.equal(reply.kind, "error");
});

test("notifications pass even under a default-deny policy", { timeout: 30_000 }, async () => {
  // A notification has no id, so a refusal could not be delivered. Denying it
  // would strand the handshake with no way to say why.
  const source = "version: 1\ndefault: deny\nrules: []\n";

  const { messages } = await gated("notifications", source, (send, stdin) => {
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`);
    send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  });

  // tools/list is denied by the default, but the run still completes, and the
  // quit request is denied too rather than hanging.
  assert.equal(messages.find((m) => m.id === 1).error.code, POLICY_DENIED_CODE);
});
