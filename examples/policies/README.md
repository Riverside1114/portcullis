# Example policies

Copy one, adapt it, and check it before use:

```sh
portcullis check filesystem.yaml
```

Test a specific call without starting anything:

```sh
portcullis check filesystem.yaml --against '{"method":"tools/call","params":{"name":"read_file","arguments":{"path":"/home/me/.env"}}}'
```

Then run with it:

```sh
portcullis run --policy filesystem.yaml --name filesystem -- npx -y @modelcontextprotocol/server-filesystem /home/me
```

| File | Shape |
|------|-------|
| `filesystem.yaml` | Default allow, with credential files, git internals and writes outside the project denied |
| `read-only.yaml` | Default deny, with only the handshake, discovery and read-shaped tools allowed |

## Writing your own

The honest order is to record first and enforce second. Run without a policy
for a session, look at `portcullis serve`, and write rules against the calls you
actually saw. A policy written from imagination tends to block the handshake and
allow the thing you were worried about.

Full syntax: [docs/policy.md](../../docs/policy.md).
