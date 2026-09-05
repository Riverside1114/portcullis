# Contributing

Portcullis is early and being built in layers. The most useful contributions
right now are the ones that make the current layer solid before the next one
starts.

## The rules that shape the code

Before proposing a change, read the four design rules in the
[README](README.md#design-rules). They are load-bearing, and a change that
breaks one will be turned down even if it is otherwise good work. The most
common way that happens:

- **Anything on the hot path that can throw.** The observer and the session run
  inside a stream carrying live protocol traffic. A crash there breaks the
  user's agent, which rule 1 forbids. Failures are logged and swallowed.
- **Anything written to stdout.** stdout is the protocol channel. A stray
  `console.log` is a corrupt JSON-RPC stream, not a cosmetic bug. Diagnostics go
  to stderr.
- **Anything that phones home.** No telemetry, no accounts, no network calls
  from the core. Rule 3 is not negotiable.
- **A required dependency from the core on another layer.** `npm install -g
  portcullis-mcp` must give you a working proxy with nothing else installed.

## Building the core

```sh
cd core
npm install
npm run build
npm test
```

`npm run dev` watches and rebuilds.

Try it against the test fixture, which is a small stand-in MCP server:

```sh
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
  | node dist/cli.js run --name scratch -- node fixtures/echo-server.mjs
portcullis tail scratch
```

Set `PORTCULLIS_HOME` to keep experiments out of your real logs.

## Tests

The suite runs on Node's built-in test runner — no framework to install.

Tests here lean towards proving properties rather than exercising functions.
The valuable ones look like *"a 2 MB payload survives intact"*, *"a multi-byte
character split across chunks is not corrupted"*, and *"truncating the log never
truncates the traffic"*. If you are fixing a bug, the test should describe the
failure in those terms.

Platform differences in stdio are real, and CI runs Linux, Windows and macOS on
Node 20 and 22 for that reason.

## Commits

Conventional commits — `feat(core):`, `fix(analyzer):`, `docs:`, `chore:`.

Write the body for someone reading it in a year with no memory of the
discussion. Say what changed and, more importantly, why that was the right
choice. A commit that only restates the diff is a wasted opportunity.

## Working on a later milestone

The [roadmap](docs/roadmap.md) is ordered deliberately, and each milestone is
finished before the next begins — no half-built layers stacked on other
half-built layers. If you want to start on something further down the list,
open an issue first so the layer beneath it can be shaped to fit.

## Security

Do not open a public issue for a vulnerability. See [SECURITY.md](SECURITY.md).
