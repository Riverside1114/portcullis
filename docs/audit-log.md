# The audit log format

The log is the part of Portcullis most likely to outlive it. If you are reading
it during an incident, you should not need Portcullis installed to make sense of
what happened. This document is the contract.

## Location

```
~/.portcullis/logs/<server>.jsonl
```

One file per proxied server, named after `--name` (or the command, if no name
was given). The directory is created with mode `0700` and the files with `0600`:
the log is a transcript of everything an agent touched, including file contents
and API responses, and should not be world-readable on a shared machine.

`PORTCULLIS_HOME` overrides the root directory.

## Format

Newline-delimited JSON. One complete record per line, appended, never rewritten.
Ordinary tools work on it directly:

```sh
# every tool call that was made
grep '"method":"tools/call"' ~/.portcullis/logs/filesystem.jsonl | jq .

# the slowest calls of the session
jq -s 'map(select(.ms)) | sort_by(-.ms) | .[0:10]' ~/.portcullis/logs/github.jsonl
```

The file is opened in append mode, so a crash never truncates history that was
already written, and several proxies can write to the same directory at once.

## Record fields

| Field | Type | Present | Meaning |
|-------|------|---------|---------|
| `v` | number | always | Schema version. Currently `1`. |
| `ts` | string | always | ISO 8601, UTC, millisecond precision. |
| `session` | string | always | UUID identifying one run of one server. |
| `server` | string | always | The server's name. |
| `seq` | number | always | Monotonic within a session, from 1. |
| `dir` | string | always | `to-server` or `to-agent`. |
| `kind` | string | always | `request`, `notification`, `response`, `error`, `malformed`. |
| `bytes` | number | always | Size of the message **as it crossed the wire**. |
| `id` | string\|number\|null | calls and replies | The JSON-RPC id. |
| `method` | string | requests, notifications, correlated replies | See correlation below. |
| `params` | any | requests, notifications | May be truncated. |
| `result` | any | responses | May be truncated. |
| `error` | object | errors | The JSON-RPC error object. |
| `ms` | number | correlated replies | Milliseconds from request to reply. |
| `truncated` | boolean | when clamped | A payload did not fit. |
| `reason` | string | malformed, uncorrelated | Why. |
| `policy` | object | when a policy judged the call | See below. |

### Why `seq` exists alongside `ts`

Timestamps collide. Several messages can share a millisecond, and sorting by
`ts` alone can reorder them. `seq` gives a total order within a session.

### Correlation

A raw JSON-RPC response carries only an `id`, not the method and not a duration.
A log of those is close to useless.

Portcullis holds each outstanding request until its reply arrives, then writes
`method` and `ms` onto the *reply* record. So a response line tells you what was
asked and how long it took, without cross-referencing anything.

Correlation is direction-aware. Both sides may originate calls: a server can ask
the agent to sample from the model or for its filesystem roots. Ids from the two
directions live in separate spaces and can legitimately collide, so a reply is
only ever matched against a request travelling the opposite way.

Ids also keep their type. JSON-RPC requires a reply to echo the id exactly, so
`1` and `"1"` are different calls and are never matched to one another.

When a reply matches nothing, it is still recorded, with:

```json
"reason": "no matching request observed"
```

That means either Portcullis started mid-conversation, or the server answered
something nobody asked. Both are worth seeing.

### Truncation

A tool result can be an entire file. Storing all of it turns the log into a
second copy of your filesystem; storing none of it makes the log useless.

Payloads over the limit (default 32 KiB, `--max-payload`) are replaced with a
marker that keeps the head and the true size:

```json
{
  "params": {
    "@portcullis": "truncated",
    "bytes": 2097231,
    "head": "{\"contents\":\"xxxxxxxx..."
  },
  "truncated": true
}
```

**Truncation applies only to the log.** The traffic itself is never altered.
`bytes` always reports what actually crossed the wire, so a truncated record
still tells you the real size of what the agent received.

### Policy verdicts

When a policy is active, every judged call carries what the policy decided and
what actually happened:

```json
"policy": {
  "verdict": "ask",
  "enforced": "deny",
  "rule": "deletion needs approval",
  "reason": "deleting files is not reversible"
}
```

`verdict` is what the rule said, `enforced` is what was done. They differ only
for `ask`, which resolves to the configured fallback while no approval front end
is connected. Keeping both means the log shows the intent as well as the
outcome. `limited: true` marks a denial that came from a rate limit rather than
the rule's action.

A denied call is recorded on the way in even though it never reached the server,
and the error sent back in its place is recorded as inbound traffic, so the log
shows both halves of the exchange.

### Malformed messages

A line that is not valid JSON-RPC is recorded as `kind: "malformed"` with a
`reason`, **and passed through unchanged**. A server printing a stray debug line
to stdout is misbehaving, and that is exactly the kind of thing the log exists
to capture, but it is not Portcullis's place to withhold it.

## Compatibility

`v` is bumped only for changes that would break a reader. New optional fields
may be added within a version; existing fields will not change meaning or type.
A reader should ignore fields it does not recognise.
