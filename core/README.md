# portcullis-mcp

The core proxy for [Portcullis](https://github.com/Riverside1114/portcullis), a
firewall and flight recorder for AI tool calls.

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

and put Portcullis in front of it. Everything after `--` is your original
command, untouched:

```json
"filesystem": {
  "command": "portcullis",
  "args": ["run", "--name", "filesystem", "--",
           "npx", "-y", "@modelcontextprotocol/server-filesystem", "/home/me"]
}
```

Your agent behaves exactly as before. That is the point. Portcullis is
transparent by default and must never be the reason something broke.

## See what happened

```sh
portcullis tail filesystem   # in the terminal
portcullis serve             # web dashboard on 127.0.0.1:7717
```

The dashboard gives a live call feed, per-method p50 and p95 latency, error
rates, filtering by method, kind and direction, and the full payload of any
record. It binds to localhost only.

## Enforce a policy

```sh
portcullis check fs.yaml
portcullis run --policy fs.yaml --name filesystem -- npx -y @modelcontextprotocol/server-filesystem /home/me
```

A denied call never reaches the server; the agent gets a JSON-RPC error in its
place. A policy that does not compile stops the proxy rather than starting it
unprotected. Syntax:
[docs/policy.md](https://github.com/Riverside1114/portcullis/blob/main/docs/policy.md).

## Current state

v0.2: a faithful passthrough, a correlated audit log, the dashboard, and policy
enforcement. Result inspection for secrets and prompt injection is next, see
[the roadmap](https://github.com/Riverside1114/portcullis/blob/main/docs/roadmap.md).

## Options

```
run
  --name <name>        Label for this server, and the log filename
  --policy <file>      Enforce a policy. Without one, Portcullis only records
  --ask-fallback <v>   What ask becomes with no approver: allow or deny
  --no-record          Pass traffic through without writing an audit log
  --max-payload <n>    Bytes of each payload to keep (default: 32768)
  --cwd <path>         Working directory for the wrapped server

tail [server]
  -n <count>           Trailing records to show (default: 50, 0 for all)
  -f, --follow         Keep printing records as they arrive
  --json               Emit raw JSONL instead of the rendered view

check <policy>
  --against <json>     Evaluate one call and print the verdict

serve
  --port <n>           Port to listen on (default: 7717)
  --host <addr>        Address to bind (default: 127.0.0.1)

global
  --log-level <level>  silent | error | warn | info | debug (default: info)
  --verbose            Shorthand for --log-level debug
  --quiet              Shorthand for --log-level error
```

Diagnostics go to stderr. stdout carries protocol traffic and is never written
to by Portcullis itself. Logs live under `~/.portcullis/logs` and never leave
the machine.

## License

MIT
