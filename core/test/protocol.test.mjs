/**
 * Framing and classification.
 *
 * These are the two places where a proxy quietly corrupts data instead of
 * failing loudly, so they get tested at the byte level rather than through the
 * proxy.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { PassThrough } from "node:stream";
import { LineFramer, classify, correlationKey, createObserver } from "../dist/index.js";

test("reassembles a message split across chunk boundaries", () => {
  const framer = new LineFramer();
  const message = '{"jsonrpc":"2.0","id":1,"method":"tools/list"}';
  const buffer = Buffer.from(`${message}\n`, "utf8");

  const first = framer.push(buffer.subarray(0, 10));
  const second = framer.push(buffer.subarray(10));

  assert.deepEqual(first, [], "a partial message must not be emitted");
  assert.deepEqual(second, [message]);
});

test("does not corrupt a multi-byte character split across chunks", () => {
  const framer = new LineFramer();
  // A naive chunk.toString() produces a replacement character here and the
  // JSON silently stops matching what the server actually sent.
  const message = '{"text":"héllo 🎉 wörld"}';
  const buffer = Buffer.from(`${message}\n`, "utf8");

  const emojiStart = buffer.indexOf(Buffer.from("🎉", "utf8"));
  const splitInsideEmoji = emojiStart + 2;

  const emitted = [
    ...framer.push(buffer.subarray(0, splitInsideEmoji)),
    ...framer.push(buffer.subarray(splitInsideEmoji)),
  ];

  assert.deepEqual(emitted, [message]);
  assert.equal(JSON.parse(emitted[0]).text, "héllo 🎉 wörld");
});

test("emits several messages arriving in one chunk", () => {
  const framer = new LineFramer();
  const lines = framer.push(Buffer.from('{"id":1}\n{"id":2}\n{"id":3}\n', "utf8"));
  assert.equal(lines.length, 3);
});

test("tolerates CRLF line endings", () => {
  const framer = new LineFramer();
  assert.deepEqual(framer.push(Buffer.from('{"id":1}\r\n', "utf8")), ['{"id":1}']);
});

test("flush returns a trailing message with no newline", () => {
  const framer = new LineFramer();
  assert.deepEqual(framer.push(Buffer.from('{"id":1}', "utf8")), []);
  assert.deepEqual(framer.flush(), ['{"id":1}']);
});

test("gives up rather than buffering without bound", () => {
  const framer = new LineFramer(64);
  assert.deepEqual(framer.push(Buffer.alloc(128, 0x61)), []);
  // Having dropped the oversized buffer it must still work afterwards.
  assert.deepEqual(framer.push(Buffer.from('{"id":1}\n', "utf8")), ['{"id":1}']);
});

test("classifies the four message shapes", () => {
  assert.equal(classify('{"jsonrpc":"2.0","id":1,"method":"tools/call"}').kind, "request");
  assert.equal(classify('{"jsonrpc":"2.0","method":"notifications/ready"}').kind, "notification");
  assert.equal(classify('{"jsonrpc":"2.0","id":1,"result":{}}').kind, "response");
  assert.equal(classify('{"jsonrpc":"2.0","id":1,"error":{"code":-1,"message":"x"}}').kind, "error");
});

test("reports unparseable lines as malformed rather than throwing", () => {
  const notJson = classify("server starting up...");
  assert.equal(notJson.kind, "malformed");
  assert.match(notJson.reason, /not JSON/);

  assert.equal(classify("[1,2,3]").kind, "malformed");
  assert.equal(classify('{"jsonrpc":"2.0"}').kind, "malformed");
});

test("keeps numeric and string ids in separate correlation spaces", () => {
  // A response echoes the id with its type intact, so these are different calls
  // and must never be attributed to one another.
  assert.notEqual(correlationKey(1), correlationKey("1"));
});

test("observer passes bytes through byte-for-byte", async () => {
  const seen = [];
  const observer = createObserver({ onLine: (line) => seen.push(line) });
  const sink = new PassThrough();

  const chunks = [];
  sink.on("data", (chunk) => chunks.push(chunk));

  observer.pipe(sink);

  // Deliberately awkward: multi-byte characters, an unparseable line, and a
  // final message with no trailing newline.
  const payload = Buffer.from('{"a":"ü🎉"}\nnot json at all\n{"b":2}', "utf8");
  observer.write(payload.subarray(0, 7));
  observer.write(payload.subarray(7, 20));
  observer.end(payload.subarray(20));

  await new Promise((resolve) => sink.on("end", resolve) || sink.on("finish", resolve));
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(
    Buffer.concat(chunks),
    payload,
    "the observer altered the traffic it was only supposed to watch",
  );
  assert.deepEqual(seen, ['{"a":"ü🎉"}', "not json at all", '{"b":2}']);
});
