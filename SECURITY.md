# Security policy

Portcullis is a security tool that sits in the middle of privileged traffic. A
flaw here is worse than a flaw in most software: it is a flaw in something
people installed *because* they were worried.

## Reporting a vulnerability

Please do not open a public issue.

Use GitHub's private reporting: **Security → Advisories → Report a
vulnerability** on
[this repository](https://github.com/Riverside1114/portcullis/security/advisories/new).

Useful to include, if you have it: the version, what an attacker gains, and the
smallest reproduction you can manage.

Expect an initial response within a few days. Portcullis is maintained by a
small number of people, so please be patient with the timeline — you will not be
ignored.

## Scope

In scope, and taken seriously:

- Traffic that is altered, dropped, or reordered in transit. The proxy's core
  promise is byte-exact forwarding.
- A path from a server name, policy file, or tool argument to writing outside
  `~/.portcullis`.
- Audit records that can be forged, suppressed, or mis-attributed — a log that
  can be made to lie is worse than no log.
- Secrets that reach the log or the model's context when a rule should have
  redacted them.
- A denial of service reachable from ordinary MCP traffic, such as a payload
  that exhausts memory.

Out of scope:

- Vulnerabilities in the MCP servers Portcullis wraps. Report those upstream.
- Prompt injection that Portcullis's heuristics fail to catch. Detection is
  best-effort and openly incomplete; a *bypass of a rule that claims to catch
  something specific* is in scope, but a novel technique nothing claims to
  detect is a feature request.
- Anything requiring an attacker who already has write access to the machine's
  home directory. At that point they can edit the policy file.

## What Portcullis does not protect against

Stated plainly, because a security tool that overclaims is itself a hazard:

- It does not sandbox the wrapped server. A server that decides to read a file
  directly, rather than through a tool call, is not observed by the proxy.
- It does not verify that a server is what it says it is. Supply-chain trust in
  the MCP server itself is a separate problem.
- Detection heuristics will have both false negatives and false positives. They
  are a layer, not a guarantee.
