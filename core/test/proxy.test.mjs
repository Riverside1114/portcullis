/**
 * Tests for the passthrough proxy.
 *
 * The bar for M1 is that an agent cannot tell Portcullis is in the path. These
 * tests encode what that means concretely: bytes survive intact in both
 * directions, large payloads are not truncated by backpressure, the server's
 * exit code is reported faithfully, and a missing server is reported as the
 * configuration error it is rather than a crash.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";
import { runProxy, ServerLaunchError, createLogger } from "../dist/index.js";

const FIXTURE = fileURLToPath(new URL("./fixtures/echo-server.mjs", import.meta.url));
const silent = createLogger({ level: "silent" });

/** Runs the fixture server behind the proxy with streams a test can drive. */
function harness() {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();

  const captured = { out: [], err: [] };
  stdout.on("data", (chunk) => captured.out.push(chunk));
  stderr.on("data", (chunk) => captured.err.push(chunk));

  const done = runProxy({
    command: process.execPath,
    args: [FIXTURE],
    logger: silent,
    streams: { stdin, stdout, stderr },
  });

  return {
    send: (message) => stdin.write(`${JSON.stringify(message)}\n`),
    quit: (code = 0) => stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 99, method: "quit", params: { code } })}\n`),
    done,
    stdoutText: () => Buffer.concat(captured.out).toString("utf8"),
    stderrText: () => Buffer.concat(captured.err).toString("utf8"),
  };
}

function responseLines(text) {
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line));
}

test("carries a request to the server and the response back", async () => {
  const h = harness();
  h.send({ jsonrpc: "2.0", id: 1, method: "tools/list" });
  h.quit();

  const outcome = await h.done;
  assert.equal(outcome.code, 0);

  const [first] = responseLines(h.stdoutText());
  assert.deepEqual(first, {
    jsonrpc: "2.0",
    id: 1,
    result: { echo: "tools/list", params: null },
  });
});

test("preserves message order across many requests", async () => {
  const h = harness();
  for (let i = 1; i <= 50; i += 1) {
    h.send({ jsonrpc: "2.0", id: i, method: `call/${i}` });
  }
  h.quit();

  await h.done;

  const responses = responseLines(h.stdoutText());
  // 50 echoes plus the quit acknowledgement.
  assert.equal(responses.length, 51);
  for (let i = 0; i < 50; i += 1) {
    assert.equal(responses[i].id, i + 1, `response ${i} arrived out of order`);
  }
});

test("does not truncate a payload larger than the pipe buffer", async () => {
  const h = harness();
  // Comfortably past the 64 KiB default high-water mark, which is where a
  // proxy that ignores backpressure starts losing bytes.
  const big = "x".repeat(2 * 1024 * 1024);
  h.send({ jsonrpc: "2.0", id: 1, method: "read_file", params: { contents: big } });
  h.quit();

  await h.done;

  const [first] = responseLines(h.stdoutText());
  assert.equal(first.result.params.contents.length, big.length);
  assert.equal(first.result.params.contents, big);
});

test("propagates the server's exit code", async () => {
  const h = harness();
  h.quit(3);

  const outcome = await h.done;
  assert.equal(outcome.code, 3);
  assert.equal(outcome.signal, null);
});

test("forwards the server's stderr untouched", async () => {
  const h = harness();
  h.quit();

  await h.done;
  assert.match(h.stderrText(), /echo-server: ready/);
});

test("reports a missing server command as a launch error", async () => {
  await assert.rejects(
    runProxy({
      command: "portcullis-no-such-command-exists",
      args: [],
      logger: silent,
      streams: { stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough() },
    }),
    (error) => {
      assert.ok(error instanceof ServerLaunchError);
      assert.match(error.message, /command not found/);
      return true;
    },
  );
});
