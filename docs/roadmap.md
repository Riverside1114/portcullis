# Roadmap

Portcullis is built in layers. Each milestone is useful on its own and is
finished before the next one starts. No half-built layers stacked on other
half-built layers.

Legend: `[x]` done, `[~]` in progress, `[ ]` not started

---

## M0, Foundation `[x]`

The repository itself. License, ignore rules, and the documents that explain
what is being built and why, so the first line of code has something to be
consistent with.

- [x] MIT license, `.gitignore` covering all five runtimes, `.editorconfig`
- [x] README stating the problem and the design rules
- [x] `docs/architecture.md`, how the pieces fit and why it is polyglot
- [x] `docs/roadmap.md`, this file

## M1, The passthrough `[x]`

The smallest thing that is real: `portcullis run -- <command>` launches the
target MCP server, wires stdio through in both directions, and gets out of the
way. No parsing, no policy. Success is measured by an agent not noticing.

- [x] Process supervision: spawn, forward signals, propagate exit code
- [x] Bidirectional stdio piping with backpressure handled correctly
- [x] Clean shutdown when either side closes
- [x] `--verbose` diagnostics on stderr, since stdout is protocol traffic

## M2, The flight recorder `[x]`

Now it understands what it is carrying. Frames are parsed as JSON-RPC, requests
are correlated to responses, and both are written to an append-only log.

- [x] Line-delimited JSON-RPC framing with partial-chunk buffering
- [x] Request and response correlation by `id`, carrying method and duration
- [x] Append-only JSONL writer at `~/.portcullis/logs/<server>.jsonl`
- [x] Detection of in-flight calls that never return
- [x] `portcullis tail`, read the log back in the terminal

This is the first genuinely valuable release. Everything after it is
enforcement; this is the part that means you can answer "what did it do?"

## M3, The dashboard `[x]`

A log you cannot read is not much of a feature. Brought forward from its
original position after M5, because the recorder was not actually useful without
it, and because it needs nothing the policy engine has not built yet.

- [x] `portcullis serve`, a localhost HTTP server on `node:http`
- [x] JSON API over the logs: server list, filtered records, statistics
- [x] Server-sent events for a live call feed
- [x] Single-page UI with no framework and no build step
- [x] Per-method p50 and p95 latency, error rates, filtering, payload detail

## M4, The policy engine `[~]`

Rules. A YAML file describing which calls are allowed, which are refused, and
which need a human.

- [ ] Policy schema: match on tool name, argument paths, glob and regex
- [ ] Verdicts: `allow`, `deny`, `ask`
- [ ] Denials returned as valid JSON-RPC errors the model can read and recover from
- [ ] Rate limits per tool
- [ ] `portcullis check <policy>`, validate a policy without running anything
- [ ] Verdicts surfaced in the dashboard
- [ ] Starter policies in `examples/policies/`

## M5, The analyzer `[ ]`

The Python sidecar. Inspects results on the way back to the model.

- [ ] Sidecar process and local socket protocol, with graceful degradation
- [ ] Secret detection for API keys, tokens and private keys, with redaction
- [ ] Prompt-injection heuristics over tool results
- [ ] Rule pack format so detections can be contributed without touching the core
- [ ] Test corpus of known-malicious tool results

## M6, The collector `[ ]`

Go daemon for log archives large enough that reading the JSONL directly stops
being cheap.

- [ ] JSONL tailing and on-disk index
- [ ] Query API matching the dashboard's existing shape
- [ ] Session replay, step through a run call by call
- [ ] Dashboard switches to the collector when it is present

## M7, The desktop app `[ ]`

Making `ask` usable. Windows first.

- [ ] WPF tray application, connects to the approval socket
- [ ] Toast notification with the pending call and its arguments
- [ ] Allow once, allow always, deny, written back to the policy file
- [ ] Live status: which servers are proxied, call counts

## Beyond

Ideas that need the layers above to exist first, in rough order of appeal:

- HTTP and SSE transports, not just stdio
- `portcullis wrap <config.json>`, rewrite an existing agent config in place
- Diffing two sessions: what did the agent do differently this time?
- Policy suggestions generated from an observed log
- Signed logs, for when the record needs to survive an argument
- macOS and Linux approval front ends
