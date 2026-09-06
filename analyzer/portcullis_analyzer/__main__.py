"""Command line entry point.

    portcullis-analyzer serve     run the sidecar the proxy talks to
    portcullis-analyzer scan      analyse a file or stdin, for testing rules
    portcullis-analyzer rules     list what is loaded
    portcullis-analyzer status    check whether a sidecar is running
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from . import __version__
from .detect import analyze
from .rules import RuleError, load


def _packs(args: argparse.Namespace):
    paths = [Path(p) for p in args.rules] if args.rules else None
    return load(paths)


def cmd_serve(args: argparse.Namespace) -> int:
    from .server import serve

    serve(host=args.host, port=args.port, packs=_packs(args))
    return 0


def cmd_scan(args: argparse.Namespace) -> int:
    text = sys.stdin.read() if args.path == "-" else Path(args.path).read_text(
        encoding="utf-8", errors="replace"
    )
    result = analyze(text, _packs(args))

    if args.json:
        print(json.dumps(result.as_dict(), indent=2))
        return 1 if result.secrets or result.flagged else 0

    if not result.findings:
        print("clean")
        return 0

    for finding in result.secrets:
        print(f"secret     {finding.severity:8} {finding.rule:22} {finding.preview}")
    for finding in result.injections:
        print(f"injection  +{finding.weight:<7} {finding.rule:22} {finding.preview[:60]}")

    if result.injections:
        verdict = "FLAGGED" if result.flagged else "below threshold"
        print(f"\ninjection score {result.score}, {verdict}")

    if args.show_redacted and result.redacted:
        print("\n--- redacted ---")
        print(result.redacted)

    return 1 if result.secrets or result.flagged else 0


def cmd_rules(args: argparse.Namespace) -> int:
    packs = _packs(args)
    print(f"{len(packs.secrets)} secret rules")
    for rule in packs.secrets:
        gate = f", entropy >= {rule.entropy}" if rule.entropy else ""
        print(f"  {rule.id:24} {rule.severity:9} {rule.name}{gate}")
    print(f"\n{len(packs.injection)} injection rules, flag at {packs.threshold}")
    for rule in packs.injection:
        print(f"  {rule.id:24} +{rule.weight:<8} {rule.name}")
    return 0


def cmd_status(args: argparse.Namespace) -> int:
    from .server import endpoint_file, probe

    reply = probe()
    if reply and reply.get("ok"):
        print(f"running, version {reply.get('version')}")
        return 0
    print(f"not running (no live sidecar at {endpoint_file()})")
    return 1


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="portcullis-analyzer", description=__doc__)
    parser.add_argument("--version", action="version", version=__version__)
    parser.add_argument(
        "--rules", action="append", metavar="FILE",
        help="rule pack to load instead of the built in ones, repeatable",
    )
    sub = parser.add_subparsers(dest="command", required=True)

    serve = sub.add_parser("serve", help="run the sidecar")
    serve.add_argument("--host", default="127.0.0.1")
    serve.add_argument("--port", type=int, default=0, help="0 picks a free port")
    serve.set_defaults(func=cmd_serve)

    scan = sub.add_parser("scan", help="analyse a file or stdin")
    scan.add_argument("path", help="file to scan, or - for stdin")
    scan.add_argument("--json", action="store_true")
    scan.add_argument("--show-redacted", action="store_true")
    scan.set_defaults(func=cmd_scan)

    rules = sub.add_parser("rules", help="list loaded rules")
    rules.set_defaults(func=cmd_rules)

    status = sub.add_parser("status", help="check for a running sidecar")
    status.set_defaults(func=cmd_status)

    args = parser.parse_args(argv)
    try:
        return int(args.func(args))
    except RuleError as error:
        print(f"error: {error}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
