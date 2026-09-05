# Architecture

This document describes how Portcullis is put together and, more importantly,
why. It is written to be read before the code.

## The one-sentence version

Portcullis is a man-in-the-middle for JSON-RPC: it speaks MCP to the agent on
one side, speaks MCP to the real server on the other, and gets to see, record,
and rule on everything that crosses.

## Where it sits

An MCP client (Claude Code, Claude Desktop, Cursor, or your own program) starts
a *server* as a subprocess and talks to it over stdin/stdout using JSON-RPC 2.0.
The config looks like this:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/me"]
    }
  }
}
```

Portcullis replaces the command. The real server becomes *its* subprocess:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "portcullis",
      "args": ["run", "--policy", "fs.yaml", "--",
               "npx", "-y", "@modelcontextprotocol/server-filesystem", "/home/me"]
    }
  }
}
```

Everything after `--` is the original command, untouched. This matters: it means
Portcullis works with *every* MCP server that exists, including ones written
after it, because it never needs to know what the server does.

```
  agent stdin  ──►  portcullis stdin   ──►  server stdin
  agent stdout ◄──  portcullis stdout  ◄──  server stdout
                          │
                          ├──► audit log (JSONL, append-only)
                          ├──► policy engine (allow / deny / ask)
                          └──► result inspection (secrets, injected text)
```

## The four things it does to a message

Traffic is bidirectional and the two directions need different treatment.

**Agent → server (a request).** This is an *intent*. The agent wants to call
`write_file` with these arguments. Here Portcullis can refuse: the call is
matched against the policy, and a denied call never reaches the server. The
agent receives a well-formed JSON-RPC error, which models handle gracefully —
they read it and try something else.

**Server → agent (a result).** This is *content*, and it is about to be placed
directly into the model's context window. Portcullis cannot meaningfully "deny"
it, but it can transform it: strip credentials that should not be there, and
annotate content that looks like it is trying to give the model instructions.

The asymmetry is the whole design. Requests get *authorisation*. Results get
*sanitisation*.

## Correlation

JSON-RPC responses carry only an `id`, not a method name. A log line that says
`response id=7: {...}` is useless. Portcullis keeps an in-flight map from `id`
to the originating request, so every record contains the method, the arguments,
the result, and the wall-clock duration. That map is also how it detects a
server that never answers.

## Why this is polyglot

Portcullis is deliberately split across several languages. Not for variety —
each layer has a different set of constraints, and forcing them into one runtime
would make each of them worse.

### `core/` — TypeScript

The proxy itself. TypeScript because MCP's reference implementation and the
overwhelming majority of MCP servers are JavaScript, so this is the runtime
already installed on every machine that needs Portcullis. It also means the
project can consume the official SDK's type definitions instead of
reimplementing the protocol from a spec document.

The core is deliberately dependency-light and does the boring, must-never-break
work: process supervision, framing, correlation, the append-only log.

### `analyzer/` — Python

Detection logic: secret patterns, prompt-injection heuristics, and eventually
classifier models over tool results.

This is Python because that is where security research lives. A researcher who
wants to contribute a new detection rule should be able to write it and test it
against a corpus without learning the proxy's internals or touching TypeScript.
It runs as a sidecar the core talks to over a local socket, and it is optional —
if the analyzer is not running, the core logs a note and keeps passing traffic.

### `collector/` — Go

A daemon that tails the JSONL logs, indexes them, and serves a query API to the
dashboard and desktop app.

Go because this ships as a single static binary with no runtime to install, and
because scanning hundreds of megabytes of JSONL is exactly the kind of work it
is good at. Asking users to have Node *and* Python *and* a database running just
to look at their own logs is a non-starter; a 10 MB binary is not.

### `dashboard/` — HTML, CSS, vanilla JS

The log viewer. No framework, no build step. It is a tool for reading a local
log file; it should load instantly and still work in five years without a
dependency upgrade. Served by the collector.

### `desktop/` — C# / WPF

A Windows tray application for the `ask` policy verdict: when a call needs a
human decision, something has to raise a real notification and block until the
user answers.

C# because that requires genuine native integration — tray icon, toast
notifications, a window that takes focus. Electron would add 150 MB to do it
worse. Linux and macOS equivalents can follow; the core's approval protocol is
a plain local socket, so any front end can implement it.

### The rule that keeps this sane

**The core never depends on any other layer.** `npm install -g portcullis` gets
you a working proxy and an audit log with nothing else installed. Every other
component is something you add when you want what it does. If that rule ever
has to break, the design is wrong.

## Data locations

| What | Where | Notes |
|------|-------|-------|
| Audit log | `~/.portcullis/logs/<server>.jsonl` | Append-only, one JSON object per line |
| Policies | User-specified via `--policy` | Plain YAML, meant to be read and diffed |
| Sockets | `~/.portcullis/run/` | Local IPC to analyzer and approval front end |

Nothing is written outside the user's home directory. Nothing is transmitted off
the machine, ever.
