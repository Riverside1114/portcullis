# Architecture

How Portcullis is put together, and why. Written to be read before the code.

## The one-sentence version

Portcullis is a man-in-the-middle for JSON-RPC. It speaks MCP to the agent on
one side, speaks MCP to the real server on the other, and gets to see, record,
and rule on everything that crosses.

## Where it sits

An MCP client (Claude Code, Claude Desktop, Cursor, or your own program) starts
a server as a subprocess and talks to it over stdin and stdout using JSON-RPC
2.0. The config looks like this:

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

Portcullis replaces the command. The real server becomes its subprocess:

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

Everything after `--` is the original command, untouched. This matters:
Portcullis works with every MCP server that exists, including ones written after
it, because it never needs to know what the server does.

```
  agent stdin  ──►  portcullis stdin   ──►  server stdin
  agent stdout ◄──  portcullis stdout  ◄──  server stdout
                          │
                          ├──► audit log (JSONL, append-only)
                          ├──► policy engine (allow, deny, ask)
                          └──► result inspection (secrets, injected text)
```

## Requests and results are not symmetric

Traffic is bidirectional, and the two directions need different treatment.

**Agent to server is an intent.** The agent wants to call `write_file` with
these arguments. Here Portcullis can refuse: the call is matched against the
policy, and a denied call never reaches the server. The agent receives a
well-formed JSON-RPC error, which models handle gracefully by reading it and
trying something else.

**Server to agent is content**, and it is about to be placed directly into the
model's context window. Portcullis cannot meaningfully deny it, but it can
transform it: strip credentials that should not be there, and annotate content
that looks like it is trying to give the model instructions.

That asymmetry is the whole design. Requests get authorisation. Results get
sanitisation.

## Correlation

JSON-RPC responses carry only an `id`, not a method name. A log line reading
`response id=7: {...}` is useless. Portcullis keeps an in-flight map from `id`
to the originating request, so every record contains the method, the arguments,
the result, and the wall-clock duration. That map is also how it detects a
server that never answers.

Correlation is direction-aware, because both sides may originate calls. A server
can ask the agent to sample from the model, or for its filesystem roots. Ids
from the two directions live in separate spaces and can legitimately collide.

## Why this is polyglot

Portcullis is split across several languages. Not for variety: each layer has a
different set of constraints, and forcing them into one runtime would make each
of them worse.

### `core/` in TypeScript

The proxy itself. TypeScript because MCP's reference implementation and the
overwhelming majority of MCP servers are JavaScript, so this is the runtime
already installed on every machine that needs Portcullis.

The core is dependency-free and does the boring, must-never-break work: process
supervision, framing, correlation, the append-only log.

### `core/dashboard/` in HTML, CSS and vanilla JS

The log viewer, served by `portcullis serve` over `node:http`. No framework and
no build step. It is a tool for reading a local log file, so it should load
instantly and still work in five years without a dependency upgrade.

It lives inside the core package rather than as a separate layer because a log
you cannot read is not much of a feature, and requiring a second install to see
your own data would have been the wrong trade.

### `analyzer/` in Python

Detection logic: secret patterns, prompt-injection heuristics, and eventually
classifier models over tool results.

Python because that is where security research lives. Someone who wants to
contribute a detection rule should be able to write it and test it against a
corpus without learning the proxy's internals or touching TypeScript. It runs as
a sidecar the core talks to over a local socket, and it is optional. If the
analyzer is not running, the core logs a note and keeps passing traffic.

### `collector/` in Go

A daemon that indexes large log archives and serves queries over them.

Today `portcullis serve` reads the JSONL directly, which is fine for the volume
a single agent session produces. It stops being fine at hundreds of megabytes.
Go because that ships as a single static binary with no runtime to install, and
scanning large JSONL is exactly what it is good at.

### `desktop/` in C# and WPF

A Windows tray application for the `ask` policy verdict. When a call needs a
human decision, something has to raise a real notification and block until the
user answers.

C# because that requires genuine native integration: tray icon, toast
notifications, a window that takes focus. Electron would add 150 MB to do it
worse. Linux and macOS equivalents can follow, since the approval protocol is a
plain local socket that any front end can implement.

### The rule that keeps this sane

**The core never depends on any other layer.** `npm install -g portcullis-mcp`
gets you a working proxy, an audit log, and the dashboard, with nothing else
installed. Every other component is something you add when you want what it
does. If that rule ever has to break, the design is wrong.

## Data locations

| What | Where | Notes |
|------|-------|-------|
| Audit log | `~/.portcullis/logs/<server>.jsonl` | Append-only, one JSON object per line |
| Policies | User-specified via `--policy` | Plain YAML, meant to be read and diffed |
| Sockets | `~/.portcullis/run/` | Local IPC to analyzer and approval front end |

Nothing is written outside the user's home directory. Nothing is transmitted off
the machine, and the dashboard binds to localhost only.
