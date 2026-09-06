#!/usr/bin/env node
/**
 * A stand-in MCP server for testing the proxy.
 *
 * It speaks just enough JSON-RPC to be a realistic target: line-delimited
 * requests in, correlated responses out, diagnostics on stderr. The `quit`
 * method lets a test end the session deterministically and choose the exit code,
 * which is how exit-code propagation is verified.
 */

import { createInterface } from "node:readline";

process.stderr.write("echo-server: ready\n");

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

rl.on("line", (line) => {
  if (line.trim() === "") return;

  let request;
  try {
    request = JSON.parse(line);
  } catch {
    send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
    return;
  }

  // A notification has no id and must never be answered. Replying would emit a
  // message with neither a method nor an id, which is not valid JSON-RPC.
  if (!("id" in request)) return;

  if (request.method === "quit") {
    const code = request.params?.code ?? 0;
    process.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { bye: true } })}\n`,
      () => process.exit(code),
    );
    return;
  }

  // Emits a credential the request never carried, which is how a real leak
  // travels: the server read it off disk.
  if (request.method === "leak") {
    send({
      jsonrpc: "2.0",
      id: request.id,
      result: {
        content: [
          { type: "text", text: "GITHUB_TOKEN=ghp_1234567890abcdefghijklmnopqrstuvwxyz" },
        ],
      },
    });
    return;
  }

  // Returns an MCP shaped tool result, so the analyzer has real content to
  // inspect rather than the echo envelope.
  if (request.method === "content") {
    send({
      jsonrpc: "2.0",
      id: request.id,
      result: { content: [{ type: "text", text: request.params?.text ?? "" }] },
    });
    return;
  }

  send({
    jsonrpc: "2.0",
    id: request.id,
    result: { echo: request.method, params: request.params ?? null },
  });
});

// No process.exit() here. A large reply may still be draining into the pipe,
// and exiting would truncate it. With stdin closed and nothing else pending,
// the loop ends on its own once the write completes.
