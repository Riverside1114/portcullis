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

  if (request.method === "quit") {
    const code = request.params?.code ?? 0;
    process.stdout.write(
      `${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { bye: true } })}\n`,
      () => process.exit(code),
    );
    return;
  }

  send({
    jsonrpc: "2.0",
    id: request.id,
    result: { echo: request.method, params: request.params ?? null },
  });
});

rl.on("close", () => process.exit(0));
