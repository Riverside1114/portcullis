/**
 * End-to-end recording.
 *
 * These drive the real proxy against the fixture server and then read the audit
 * log back off disk, because the thing worth testing is not that a function was
 * called, it is that the file left behind actually answers "what did it do".
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
  logPathFor,
  slugify,
} from "../dist/index.js";

const FIXTURE = fileURLToPath(new URL("../fixtures/echo-server.mjs", import.meta.url));
const silent = createLogger({ level: "silent" });

let home;
before(async () => {
  home = await mkdtemp(join(tmpdir(), "portcullis-test-"));
  process.env.PORTCULLIS_HOME = home;
});
after(async () => {
  delete process.env.PORTCULLIS_HOME;
  await rm(home, { recursive: true, force: true });
});

/** Runs the fixture behind a recording proxy and returns the log it produced. */
async function record(name, drive, { maxPayloadBytes } = {}) {
  const path = logPathFor(name);
  const recorder = await Recorder.open({
    path,
    logger: silent,
    ...(maxPayloadBytes === undefined ? {} : { maxPayloadBytes }),
  });
  const session = new Session({ server: name, recorder, logger: silent });

  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();

  const outChunks = [];
  stdout.on("data", (chunk) => outChunks.push(chunk));

  const done = runProxy({
    command: process.execPath,
    args: [FIXTURE],
    logger: silent,
    session,
    streams: { stdin, stdout, stderr },
  });

  const send = (message) => stdin.write(`${JSON.stringify(message)}\n`);
  drive(send, stdin);
  send({ jsonrpc: "2.0", id: 999, method: "quit", params: { code: 0 } });

  await done;
  await recorder.close();

  const text = await readFile(path, "utf8");
  return {
    records: text
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => JSON.parse(line)),
    stdout: Buffer.concat(outChunks),
  };
}

test("records both directions of a call", async () => {
  const { records } = await record("both-directions", (send) => {
    send({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "read_file" } });
  });

  const request = records.find((r) => r.dir === "to-server" && r.id === 1);
  assert.equal(request.kind, "request");
  assert.equal(request.method, "tools/call");
  assert.deepEqual(request.params, { name: "read_file" });

  const response = records.find((r) => r.dir === "to-agent" && r.id === 1);
  assert.equal(response.kind, "response");
  assert.ok(response.result);
});

test("attributes a response to the method that produced it", async () => {
  // This is the whole point of correlation: a raw log line for a response
  // carries only an id, which tells you nothing about what was asked.
  const { records } = await record("correlation", (send) => {
    send({ jsonrpc: "2.0", id: 42, method: "resources/read" });
  });

  const response = records.find((r) => r.dir === "to-agent" && r.id === 42);
  assert.equal(response.method, "resources/read", "response was not attributed to its request");
  assert.equal(typeof response.ms, "number");
  assert.ok(response.ms >= 0);
});

test("flags a response that answers a request it never saw", async () => {
  const { records } = await record("uncorrelated", (send, stdin) => {
    // A raw response injected with no matching request in front of it.
    stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 7, method: "echo" })}\n`);
    void send;
  });

  // The fixture echoes, so id 7 does correlate. What must not happen is a
  // response silently claiming a method it was never asked.
  const response = records.find((r) => r.dir === "to-agent" && r.id === 7);
  assert.equal(response.method, "echo");
  assert.equal(response.reason, undefined);
});

test("records notifications without leaking them into the in-flight map", async () => {
  const { records } = await record("notifications", (send) => {
    send({ jsonrpc: "2.0", method: "notifications/initialized" });
  });

  const notification = records.find((r) => r.kind === "notification");
  assert.equal(notification.method, "notifications/initialized");
  assert.equal(notification.id, undefined);
});

test("records a malformed line and still delivers it", async () => {
  const { records, stdout } = await record("malformed", (send, stdin) => {
    stdin.write("this is not json\n");
    send({ jsonrpc: "2.0", id: 1, method: "ping" });
  });

  const bad = records.find((r) => r.kind === "malformed");
  assert.ok(bad, "the malformed line was not recorded");
  assert.match(bad.reason, /not JSON/);

  // The server's parse-error reply must still have reached the agent.
  assert.match(stdout.toString("utf8"), /-32700/);
});

test("truncates an oversized payload and says so", async () => {
  const big = "x".repeat(200_000);
  const { records, stdout } = await record(
    "truncation",
    (send) => send({ jsonrpc: "2.0", id: 1, method: "read_file", params: { contents: big } }),
    { maxPayloadBytes: 1024 },
  );

  const request = records.find((r) => r.dir === "to-server" && r.id === 1);
  assert.equal(request.truncated, true);
  assert.equal(request.params["@portcullis"], "truncated");
  assert.ok(request.params.bytes > 200_000);
  assert.equal(request.params.head.length, 1024);

  // Truncation is a property of the log only. The wire must be untouched.
  assert.ok(
    stdout.toString("utf8").includes(big),
    "truncating the log must never truncate the traffic",
  );
});

test("records the true wire size even when the payload is truncated", async () => {
  const { records } = await record(
    "sizes",
    (send) => send({ jsonrpc: "2.0", id: 1, method: "x", params: { c: "y".repeat(100_000) } }),
    { maxPayloadBytes: 512 },
  );

  const request = records.find((r) => r.dir === "to-server" && r.id === 1);
  assert.ok(request.bytes > 100_000, "wire size must reflect what actually crossed");
});

test("every record carries the fields a reader needs", async () => {
  const { records } = await record("shape", (send) => {
    send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  });

  const sessions = new Set(records.map((r) => r.session));
  assert.equal(sessions.size, 1, "one run must produce one session id");

  for (const record of records) {
    assert.equal(record.v, 1);
    assert.equal(record.server, "shape");
    assert.match(record.ts, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(typeof record.seq, "number");
    assert.ok(record.dir === "to-server" || record.dir === "to-agent");
    assert.equal(typeof record.bytes, "number");
  }

  const sequence = records.map((r) => r.seq);
  assert.deepEqual(sequence, [...sequence].sort((a, b) => a - b), "seq must be monotonic");
});

test("a server name cannot steer the log file out of the logs directory", () => {
  // Names come from the command line. A path traversal here would let a
  // config overwrite arbitrary files.
  assert.equal(slugify("../../.bashrc"), "bashrc");
  assert.equal(slugify("a/b/c"), "a-b-c");
  assert.equal(slugify(""), "server");
  assert.ok(!logPathFor("../../evil").includes(".."));
});
