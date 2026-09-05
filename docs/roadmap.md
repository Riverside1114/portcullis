# Roadmap

Portcullis is built in layers. Each milestone is useful on its own and is
finished before the next one starts — no half-built layers stacked on other
half-built layers.

Legend: `[x]` done · `[~]` in progress · `[ ]` not started

---

## M0 — Foundation `[x]`

The repository itself. License, ignore rules, and the two documents that explain
what is being built and why, so that the first line of code has something to be
consistent with.

- [x] MIT license, `.gitignore` covering all five runtimes, `.editorconfig`
- [x] README stating the problem and the design rules
- [x] `docs/architecture.md` — how the pieces fit and why it is polyglot
- [x] `docs/roadmap.md` — this file

## M1 — The passthrough `[~]`

The smallest thing that is real: `portcullis run -- <command>` launches the
target MCP server, wires stdio through in both directions, and gets out of the
way. No parsing, no policy. Success is measured by an agent not noticing.

- [~] Process supervision — spawn, forward signals, propagate exit code
- [~] Bidirectional stdio piping with backpressure handled correctly
- [ ] Clean shutdown when either side closes
- [ ] `--verbose` diagnostics on stderr (stdout is protocol traffic and is sacred)

## M2 — The flight recorder `[ ]`

Now it understands what it is carrying. Frames are parsed as JSON-RPC, requests
are correlated to responses, and both are written to an append-only log.

- [ ] Line-delimited JSON-RPC framing with partial-chunk buffering
- [ ] Request/response correlation by `id`, carrying method and duration
- [ ] Append-only JSONL writer at `~/.portcullis/logs/<server>.jsonl`
- [ ] Detection of in-flight calls that never return
- [ ] `portcullis tail` — read the log back in the terminal

**This is the first genuinely valuable release.** Everything after it is
enforcement; this is the part that means you can answer "what did it do?"

## M3 — The policy engine `[ ]`

Rules. A YAML file describing which calls are allowed, which are refused, and
which need a human.

- [ ] Policy schema: match on tool name, argument paths, glob and regex
- [ ] Verdicts: `allow`, `deny`, `ask`
- [ ] Denials returned as valid JSON-RPC errors the model can read and recover from
- [ ] Rate limits per tool
- [ ] `portcullis check <policy>` — validate a policy without running anything
- [ ] Starter policies in `examples/policies/`

## M4 — The analyzer `[ ]`

The Python sidecar. Inspects results on the way back to the model.

- [ ] Sidecar process and local socket protocol, with graceful degradation
- [ ] Secret detection — API keys, tokens, private keys — with redaction
- [ ] Prompt-injection heuristics over tool results
- [ ] Rule pack format so detections can be contributed without touching the core
- [ ] Test corpus of known-malicious tool results

## M5 — The collector and dashboard `[ ]`

Reading the log properly. Go daemon, browser UI.

- [ ] JSONL tailing and in-memory index
- [ ] Query API — filter by server, tool, verdict, time range
- [ ] Single-page dashboard: live call feed, timeline, per-tool statistics
- [ ] Session replay — step through a run call by call

## M6 — The desktop app `[ ]`

Making `ask` usable. Windows first.

- [ ] WPF tray application, connects to the approval socket
- [ ] Toast notification with the pending call and its arguments
- [ ] Allow once / allow always / deny, written back to the policy file
- [ ] Live status: which servers are proxied, call counts

## Beyond

Ideas that need the layers above to exist first, in rough order of appeal:

- HTTP and SSE transports, not just stdio
- `portcullis wrap <config.json>` — rewrite an existing agent config in place
- Diffing two sessions: what did the agent do differently this time?
- Policy suggestions generated from an observed log ("you allowed these 12 tools")
- Signed logs, for when the record needs to survive an argument
- macOS and Linux approval front ends
