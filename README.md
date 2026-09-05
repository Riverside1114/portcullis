<div align="center">

# Portcullis

**A firewall and flight recorder for AI tool calls.**

Your AI agent can read your filesystem, hit your internal APIs, and send email
on your behalf. Right now you have no idea what it actually did.

Portcullis sits between the agent and its tools, records every call, and stops
the ones you never agreed to.

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Status: early](https://img.shields.io/badge/status-early%20development-orange.svg)](docs/roadmap.md)

</div>

---

## The problem

The Model Context Protocol (MCP) made it trivial to give a language model real
capabilities. A dozen lines of config and your agent can touch your git repos,
your database, your Slack workspace, your cloud account.

What it did not come with:

- **No record.** When an agent deletes the wrong file or posts the wrong
  message, there is no log of the call that did it.
- **No boundary.** An MCP server advertised as "read files" is trusted to only
  read files. Nothing enforces that.
- **No inspection of what comes back.** Tool results are fed straight into the
  model's context. A web page, an issue comment, or a file the agent reads can
  contain text written to hijack it — and it arrives pre-trusted.
- **No redaction.** An API key sitting in a `.env` the agent read is now in the
  model's context, and in whatever transcript your provider keeps.

Every one of these is a solved problem in ordinary software. We have proxies,
audit logs, and firewalls. Agents just skipped that entire layer.

## The idea

Portcullis is a proxy that speaks MCP on both sides. You change one line of
config — pointing your agent at Portcullis instead of the real server — and
everything else keeps working.

```
                    ┌──────────────────────────────┐
   AI agent  ◄─────►│  Portcullis                  │◄─────►  real MCP server
   (Claude,         │                              │         (filesystem, git,
    Cursor,         │  • records every call        │          github, postgres…)
    your app)       │  • enforces a policy file    │
                    │  • redacts secrets in results│
                    │  • flags injected content    │
                    └──────────────────────────────┘
```

Nothing about your agent changes. It does not know Portcullis is there.

## Design rules

These are load-bearing. Everything in the roadmap is checked against them.

1. **Transparent by default.** Installing Portcullis with no policy changes
   nothing except that a log now exists. It must never be the reason something
   broke.
2. **Fail visible, not silent.** If Portcullis cannot evaluate a policy, it says
   so loudly rather than quietly allowing or quietly denying.
3. **The log is append-only and local.** Your tool traffic is some of the most
   sensitive data you have. It never leaves the machine. There is no account,
   no telemetry, no phone-home.
4. **The core runs alone.** The proxy is TypeScript with a minimal dependency
   set. The analyzer, dashboard, and desktop app are *optional layers* — if you
   only want the log, you never install them.

## Project status

Early. Being built in public, in layers, from the ground up.
See [the roadmap](docs/roadmap.md) for what exists and what is next.

| Layer | Language | State |
|-------|----------|-------|
| `core/` — the proxy | TypeScript | recording works |
| `analyzer/` — detection rules | Python | planned |
| `collector/` — log query daemon | Go | planned |
| `dashboard/` — log viewer | HTML/CSS/JS | planned |
| `desktop/` — tray app, live approvals | C# / WPF | planned |

Why several languages? Each layer is a genuinely different job, and the split
is explained in [docs/architecture.md](docs/architecture.md#why-this-is-polyglot).
The core never depends on the others.

## The log

Once Portcullis is in the path, every call is on disk in a format meant to be
read by other tools — see [docs/audit-log.md](docs/audit-log.md).

```
$ portcullis tail filesystem
12:46:26.481  -->  initialize                 call             88 B
12:46:26.482  -->  tools/call                 call            111 B
12:46:26.557  <--  initialize                 ok             75ms     97 B
12:46:26.558  <--  tools/call                 ok             76ms    120 B
```

A response line carries the method that produced it and how long it took, which
the raw protocol does not — a JSON-RPC reply contains only an id.

## License

MIT — see [LICENSE](LICENSE).
