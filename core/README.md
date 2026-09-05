# portcullis-mcp

The core proxy for [Portcullis](https://github.com/Riverside1114/portcullis) — a
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

Your agent behaves exactly as before. That is the point — Portcullis is
transparent by default and must never be the reason something broke.

## Current state

This is v0.1: a faithful passthrough with diagnostics. Recording and policy
enforcement land in the next two milestones — see
[the roadmap](https://github.com/Riverside1114/portcullis/blob/main/docs/roadmap.md).

## Options

```
--name <name>        Label for this server in logs
--log-level <level>  silent | error | warn | info | debug   (default: info)
--verbose            Shorthand for --log-level debug
--quiet              Shorthand for --log-level error
--cwd <path>         Working directory for the wrapped server
```

Diagnostics go to stderr. stdout carries protocol traffic and is never written
to by Portcullis itself.

## License

MIT
