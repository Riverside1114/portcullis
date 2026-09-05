"""Runs the real Portcullis CLI and captures what it prints.

Nothing in the promo is typed out by hand. If the tool's output changes, the
demo changes with it, which is the only way a promo asset stays honest.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path

from .terminal import strip_ansi

REPO = Path(__file__).resolve().parents[2]
CORE = REPO / "core"
CLI = CORE / "dist" / "cli.js"
EXAMPLES = REPO / "examples" / "policies"


class BuildRequired(RuntimeError):
    pass


@dataclass
class Capture:
    stdout: list[str]
    stderr: list[str]
    code: int


def _env(home: Path) -> dict[str, str]:
    env = dict(os.environ)
    env["PORTCULLIS_HOME"] = str(home)
    # Colour is added by the renderer, not by the tool, so the captured text
    # stays clean.
    env["NO_COLOR"] = "1"
    return env


def run(args: list[str], home: Path, stdin: str | None = None) -> Capture:
    if not CLI.exists():
        raise BuildRequired(
            f"{CLI} is missing. Build the core first:\n"
            f"  cd {CORE} && npm install && npm run build"
        )

    result = subprocess.run(
        ["node", str(CLI), *args],
        cwd=CORE,
        env=_env(home),
        input=stdin,
        capture_output=True,
        text=True,
        encoding="utf-8",
        timeout=120,
    )

    return Capture(
        stdout=[strip_ansi(line) for line in result.stdout.splitlines()],
        stderr=[strip_ansi(line) for line in result.stderr.splitlines()],
        code=result.returncode,
    )


@dataclass
class Demo:
    """Everything the terminal scenes need, captured from real runs."""

    check: list[str]
    explain_denied: list[str]
    denial_json: list[str]
    tail: list[str]
    policy_source: list[str]


def collect() -> Demo:
    home = Path(tempfile.mkdtemp(prefix="portcullis-promo-"))
    try:
        policy = EXAMPLES / "filesystem.yaml"

        check = run(["check", str(policy)], home)

        explain = run(
            [
                "check",
                str(policy),
                "--against",
                json.dumps(
                    {
                        "method": "tools/call",
                        "params": {"name": "read_file", "arguments": {"path": "/home/me/.env"}},
                    }
                ),
            ],
            home,
        )

        # A real gated session against the fixture server, so the denial below
        # is the one the proxy actually produced.
        requests = [
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "tools/call",
                "params": {"name": "read_file", "arguments": {"path": "/home/me/project/src/app.ts"}},
            },
            {
                "jsonrpc": "2.0",
                "id": 2,
                "method": "tools/call",
                "params": {"name": "read_file", "arguments": {"path": "/home/me/.env"}},
            },
            {"jsonrpc": "2.0", "id": 3, "method": "quit", "params": {"code": 0}},
        ]

        session = run(
            [
                "run",
                "--name",
                "filesystem",
                "--policy",
                str(policy),
                "--",
                "node",
                str(CORE / "fixtures" / "echo-server.mjs"),
            ],
            home,
            stdin="\n".join(json.dumps(r) for r in requests) + "\n",
        )

        denial = next(
            (line for line in session.stdout if '"error"' in line and "-32001" in line),
            "",
        )

        tail = run(["tail", "filesystem"], home)

        return Demo(
            check=check.stdout,
            explain_denied=explain.stdout,
            denial_json=_pretty(denial),
            tail=tail.stdout,
            policy_source=policy.read_text(encoding="utf-8").splitlines(),
        )
    finally:
        shutil.rmtree(home, ignore_errors=True)


def _pretty(line: str) -> list[str]:
    if not line:
        return ["(no denial captured)"]
    try:
        return json.dumps(json.loads(line), indent=2).splitlines()
    except json.JSONDecodeError:
        return [line]
