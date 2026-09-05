<div align="center">

# Portcullis

**A firewall and flight recorder for AI tool calls.**

Your AI agent can read your filesystem, hit your internal APIs, and send email
on your behalf. Right now you have no idea what it actually did.

Portcullis sits between the agent and its tools, records every call, and stops
the ones you never agreed to.

[![CI](https://github.com/Riverside1114/portcullis/actions/workflows/ci.yml/badge.svg)](https://github.com/Riverside1114/portcullis/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Status: early](https://img.shields.io/badge/status-early%20development-orange.svg)](docs/roadmap.md)

</div>

---

## The problem

The Model Context Protocol made it trivial to give a language model real
capabilities. A dozen lines of config and your agent can touch your git repos,
your database, your Slack workspace, your cloud account.

What it did not come with:

- **No record.** When an agent deletes the wrong file or posts the wrong
  message, there is no log of the call that did it.
- **No boundary.** An MCP server advertised as "read files" is trusted to only
  read files. Nothing enforces that.
- **No inspection of what comes back.** Tool results are fed straight into the
  model's context. A web page, an issue comment, or a file the agent reads can
  contain text written to hijack it, and it arrives pre-trusted.
- **No redaction.** An API key sitting in a `.env` the agent read is now in the
  model's context, and in whatever transcript your provider keeps.

Every one of these is a solved problem in ordinary software. We have proxies,
audit logs, and firewalls. Agents skipped that entire layer.

## The idea

Portcullis is a proxy that speaks MCP on both sides. You change one line of
config, pointing your agent at Portcullis instead of the real server, and
everything else keeps working.

```
                    ┌──────────────────────────────┐
   AI agent  ◄─────►│  Portcullis                  │◄─────►  real MCP server
   (Claude,         │                              │         (filesystem, git,
    Cursor,         │  • records every call        │          github, postgres)
    your app)       │  • enforces a policy file    │
                    │  • redacts secrets in results│
                    │  • flags injected content    │
                    └──────────────────────────────┘
```

Nothing about your agent changes. It does not know Portcullis is there.

## Install

```sh
npm install -g portcullis-mcp
```

## Use

Take the MCP server entry in your agent's config:

```json
"filesystem": {
  "command": "npx",
  "args": ["-y", "@modelcontextprotocol/server-filesystem", "/home/me"]
}
```

Put Portcullis in front of it. Everything after `--` is your original command,
untouched:

```json
"filesystem": {
  "command": "portcullis",
  "args": ["run", "--name", "filesystem", "--",
           "npx", "-y", "@modelcontextprotocol/server-filesystem", "/home/me"]
}
```

That separator is the key design choice. Portcullis never has to parse or
understand the wrapped command, so it works with every MCP server that exists,
including ones written after it.

## See what happened

In the terminal:

```sh
portcullis tail filesystem
```

```
12:59:47.316  -->  tools/call        call            143 B
12:59:47.384  <--  tools/call        ok      68ms    120 B
12:59:47.316  -->  (uncorrelated)    malformed: not JSON: Unexpected...   13 B
```

A response line carries the method that produced it and how long it took. The
raw protocol does not: a JSON-RPC reply contains only an id.

Or in the browser:

```sh
portcullis serve
```

A local dashboard on `127.0.0.1:7717` with a live call feed, per-method p50 and
p95 latency, error rates, filtering by method, kind and direction, and a detail
drawer showing the full payload of any record. No framework, no build step, no
network access. It binds to localhost only, because the log holds file contents
and API responses your agent saw.

## Stop what you did not agree to

Recording tells you what happened. A policy decides what is allowed to.

```yaml
version: 1
default: allow

rules:
  - name: no credential files
    action: deny
    reason: credential files are off limits
    match:
      args:
        path: ["**/.env", "**/.ssh/**", "**/*.pem"]

  - name: writes stay in the project
    action: deny
    match:
      tool: [write_file, edit_file]
      args:
        path: "!/home/me/project/**"
```

```sh
portcullis check fs.yaml
portcullis run --policy fs.yaml --name filesystem -- npx -y @modelcontextprotocol/server-filesystem /home/me
```

A denied call never reaches the server. The agent gets a JSON-RPC error in its
place, worded so the model looks for another route instead of retrying:

```
Blocked by Portcullis policy "no credential files": credential files are off
limits. This call was not sent to the server. Do not retry it unchanged.
```

A policy that does not compile stops the proxy rather than starting it
unprotected. Test one before you deploy it:

```sh
portcullis check fs.yaml --against '{"method":"tools/call","params":{"name":"read_file","arguments":{"path":"/home/me/.env"}}}'
deny by rule "no credential files": credential files are off limits
```

Full syntax in [docs/policy.md](docs/policy.md), starting points in
[examples/policies](examples/policies).

## Design rules

These are load-bearing. Everything in the roadmap is checked against them.

1. **Transparent by default.** Installing Portcullis with no policy changes
   nothing except that a log now exists. It must never be the reason something
   broke.
2. **Fail visible, not silent.** If Portcullis cannot evaluate a policy, it says
   so loudly rather than quietly allowing or quietly denying.
3. **The log is append-only and local.** Your tool traffic is some of the most
   sensitive data you have. It never leaves the machine. There is no account, no
   telemetry, no phone-home.
4. **The core runs alone.** The proxy is TypeScript with zero runtime
   dependencies. Later layers are optional; if you only want the log and the
   dashboard, you install nothing else.

## Project status

Early, and built in public in layers. See [the roadmap](docs/roadmap.md).

| Layer | Language | State |
|-------|----------|-------|
| `core/` proxy and recorder | TypeScript | working |
| `core/dashboard/` web UI | HTML, CSS, JS | working |
| policy engine | TypeScript | working |
| `analyzer/` detection rules | Python | next |
| `collector/` log index for large archives | Go | planned |
| `desktop/` tray app and live approvals | C# and WPF | planned |

Why several languages? Each layer is a genuinely different job, and the split is
explained in [docs/architecture.md](docs/architecture.md#why-this-is-polyglot).
The core never depends on the others.

## Documentation

- [Policy](docs/policy.md), the rule syntax and what the model sees
- [Architecture](docs/architecture.md), how the pieces fit and why
- [Audit log format](docs/audit-log.md), a stable contract other tools can read
- [Roadmap](docs/roadmap.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)

## License

MIT, see [LICENSE](LICENSE).
