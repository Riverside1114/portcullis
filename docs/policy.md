# Policy

A policy is a file describing which calls Portcullis lets through. Without one,
Portcullis only records. With one, denied calls never reach the server.

```sh
portcullis check fs.yaml
portcullis run --policy fs.yaml --name filesystem -- npx -y @modelcontextprotocol/server-filesystem /home/me
```

## Write it second, not first

The honest order is to record first and enforce afterwards. Run without a
policy for a session, open `portcullis serve`, and write rules against the calls
you actually saw. Policies written from imagination tend to block the handshake
and allow the thing you were worried about.

## Shape

```yaml
version: 1
default: allow        # allow, deny or ask
ask_fallback: deny    # what ask becomes while no approver is connected

rules:
  - name: no credential files
    action: deny
    reason: credential files are off limits
    match:
      args:
        path: ["**/.env", "**/id_rsa*"]

  - name: fetching has a ceiling
    action: allow
    match:
      tool: fetch_url
    limit:
      calls: 30
      per: 1m
```

Rules are evaluated in order and the first match wins. A call matching nothing
gets the policy `default`.

JSON works too, with the same structure. Portcullis picks the parser from the
file extension.

## Fields

| Field | Where | Meaning |
|-------|-------|---------|
| `version` | top level | Required, currently `1`. |
| `default` | top level | Verdict for calls no rule matched. Defaults to `allow`. |
| `ask_fallback` | top level | `allow` or `deny`. Defaults to `deny`. |
| `name` | rule | Required, unique, and used in logs and error messages. |
| `action` | rule | `allow`, `deny` or `ask`. Required. |
| `reason` | rule | Shown to the model in the denial. Worth writing. |
| `match.method` | rule | Patterns against the JSON-RPC method. |
| `match.tool` | rule | Patterns against `params.name`. |
| `match.args` | rule | Map of argument path to patterns. |
| `limit.calls` | rule | Ceiling within the window. |
| `limit.per` | rule | Window: `30`, `"500ms"`, `"90s"`, `"5m"`, `"2h"`. A bare number is seconds. |

Every key is checked. An unknown one is an error with a suggestion, because a
typo such as `tools:` for `tool:` would otherwise widen a rule in silence.

A rule with no `match` and no `limit` is rejected: it would apply to every call,
which is what `default` is for.

## Patterns

Three forms:

| Form | Example | Notes |
|------|---------|-------|
| Glob | `/home/me/**` | The default. `*` stops at `/`, `**` crosses it. |
| Regex | `re:^tools/` | Prefixed. `re:/^TOOLS/i` passes flags. |
| Negated | `!/home/me/**` | Applies to either form above. |

Globs support `*`, `**`, `?`, `[abc]`, `[!abc]` and `{a,b}`. As a convenience
`a/**/b` also matches `a/b`.

Regexes need the `re:` prefix rather than slash delimiters, because policy
patterns are usually absolute paths and `/home/me/**` would otherwise read as a
regex with nonsense flags.

A single pattern or a list is accepted anywhere patterns are. In a list, the
value matches if it matches at least one positive pattern and passes every
negated one:

```yaml
match:
  args:
    path: ["/home/me/**", "!**/.env"]   # under home, but never a .env
```

## Matching arguments

`match.args` keys are dotted paths into the call's arguments. `tools/call`
nests them under `params.arguments`; other methods carry them on `params`
directly. Both are searched, so you do not have to know which is which.

```yaml
match:
  args:
    target.environment: prod    # params.arguments.target.environment
```

**An absent argument never matches**, including against a negated pattern. A
rule naming `path` only applies to calls that actually carry a `path`. The
alternative, where a missing value satisfies a negation, produces rules that
fire on calls they were never about.

Values are compared as strings. Numbers and booleans are stringified; objects
and arrays are compared as their JSON.

## What gets judged

Only requests. A response cannot be refused after the fact, and a notification
has no reply that could carry a refusal, so both pass untouched.

That includes `notifications/initialized`, which means a `default: deny` policy
still completes the handshake rather than deadlocking.

## What the model sees

A denied call never reaches the server. The agent receives a JSON-RPC error in
its place:

```json
{
  "jsonrpc": "2.0",
  "id": 3,
  "error": {
    "code": -32001,
    "message": "Blocked by Portcullis policy \"no credential files\": credential files are off limits. This call was not sent to the server. Do not retry it unchanged.",
    "data": {
      "portcullis": "denied",
      "rule": "no credential files",
      "reason": "credential files are off limits",
      "method": "tools/call"
    }
  }
}
```

The wording is deliberate. Models read these and act on them, so it has to say
the call was refused rather than that it failed, or the model retries the same
call. Your `reason` is the part it reads, so write it as an instruction to
someone looking for another route.

## Rate limits

A `limit` on a rule is a sliding window. Calls that reach the rule are counted;
once the ceiling is passed, further matches are denied until the window moves
on, whatever the rule's `action` says.

```yaml
- name: reading has a ceiling
  action: allow
  match:
    tool: [read_file, read_multiple_files]
  limit:
    calls: 300
    per: 1m
```

This is a ceiling, not a target. A runaway loop reading the filesystem is a real
failure mode and an expensive one.

## ask

`ask` is for calls that should involve a person. The approval front end is a
later milestone, so until it exists an `ask` verdict resolves to `ask_fallback`
(`deny` unless you say otherwise) and says so loudly in the log.

The audit record keeps both, so you can see what the rule wanted and what
actually happened:

```json
"policy": { "verdict": "ask", "enforced": "deny", "rule": "deletion needs approval" }
```

## Failure behaviour

A policy that cannot be read or does not compile **stops the proxy**. Portcullis
will not start the server without the rules you asked for, because that would
drop your protection at the exact moment you believe it is on.

Check before you deploy:

```sh
portcullis check fs.yaml
portcullis check fs.yaml --against '{"method":"tools/call","params":{"name":"read_file","arguments":{"path":"/home/me/.env"}}}'
```

`--against` prints the verdict and the rule that produced it, and exits non-zero
on a denial, so it works in a test script.

## Cost

Without a policy Portcullis never holds a byte: it observes each direction and
passes the original bytes straight through.

With a policy both directions are reassembled into whole messages, because a
call cannot be judged from half of one, and because a denial has to be injected
on a message boundary rather than into the middle of one. Messages are still
forwarded byte for byte; only the chunking differs.

A message larger than 16 MB cannot be evaluated and is refused. Portcullis tries
to recover the id so it can send a proper error, and logs the event either way.

## The YAML it accepts

Portcullis ships with no runtime dependencies, which for a tool about supply
chain risk is worth more than full YAML coverage, so it parses a deliberate
subset: block maps, block sequences, inline sequences, quoted strings, numbers,
booleans, null and comments.

Anchors, aliases, tags, multiple documents, block scalars and flow maps are
parse errors naming the line, never a silent misreading. If you need something
outside the subset, write the policy as JSON.
