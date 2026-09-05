"""Scene definitions built from the real captured output."""

from __future__ import annotations

import re

from .capture import Demo
from .terminal import Emit, Event, Typed, Wait

SERVER = "npx -y @modelcontextprotocol/server-filesystem ~"


def _colour_check(lines: list[str]) -> list[str]:
    """Adds markup to `portcullis check` output so verdicts read at a glance."""
    out: list[str] = []
    for line in lines:
        if line.startswith("valid "):
            # The capture used an absolute path; show the name that was typed.
            out.append("{ok:valid} fs.yaml")
        elif re.match(r"\s+\d+\.", line):
            line = re.sub(r"\bdeny\b", "{error:deny}", line, count=1)
            line = re.sub(r"\ballow\b", "{ok:allow}", line, count=1)
            line = re.sub(r"\bask\b", "{warn:ask}", line, count=1)
            out.append(line)
        elif line.strip().startswith(("default", "ask fallback")):
            out.append("{dim:" + line + "}")
        else:
            out.append("{faint:" + line + "}" if line.strip() else line)
    return out


def _colour_tail(lines: list[str]) -> list[str]:
    out: list[str] = []
    # The fixture's shutdown call is a test artefact, not something an agent does.
    for line in (l for l in lines if " quit " not in l):
        if "error" in line:
            out.append("{error:" + line + "}")
        elif " ok " in line:
            out.append(line.replace(" ok ", " {ok:ok} ", 1))
        else:
            out.append("{dim:" + line + "}")
    return out


def _shorten_check(lines: list[str], keep: int = 5) -> list[str]:
    """Trims the long pattern lists so the rule table fits the frame."""
    out: list[str] = []
    for line in lines:
        if len(line) > 96:
            line = line[:93].rstrip() + " ..."
        out.append(line)
    return out


def readme_demo(demo: Demo) -> list[Event]:
    """The short loop for the top of the README. Around twenty seconds."""
    check = _colour_check(_shorten_check(demo.check))
    tail = _colour_tail(demo.tail)

    return [
        Wait(0.6),
        Typed("portcullis check fs.yaml"),
        Emit(check, pause_after=1.9),
        Emit([""]),
        Typed(f"portcullis run --policy fs.yaml -- {SERVER}"),
        Emit(
            [
                "{faint:portcullis:filesystem info  policy fs.yaml: 5 rules, default allow}",
                "{faint:portcullis:filesystem info  starting " + SERVER + "}",
            ],
            pause_after=1.0,
        ),
        Emit(["{dim:  the agent reads a project file ...}"], pause_after=0.9),
        Emit(
            ["{warn:portcullis:filesystem info  denied tools/call by rule \"no credential files\"}"],
            pause_after=1.8,
        ),
        Emit([""]),
        Typed("portcullis tail filesystem"),
        Emit(tail, pause_after=2.6),
    ]


def policy_scene(demo: Demo) -> list[Event]:
    """The policy file typing itself out, for the long video."""
    body = [
        line
        for line in demo.policy_source
        if line.strip() and not line.strip().startswith("#")
    ][:22]

    coloured: list[str] = []
    for line in body:
        if ":" in line and not line.strip().startswith("-"):
            key, _, rest = line.partition(":")
            coloured.append("{accent:" + key + "}:{text:" + rest + "}")
        else:
            coloured.append(line)

    return [
        Wait(0.4),
        Emit(["{faint:# fs.yaml}"], pause_after=0.3),
        Emit(coloured, delay_between=0.12, pause_after=1.4),
    ]


def denial_scene(demo: Demo) -> list[Event]:
    """What the model receives in place of the blocked call."""
    lines = []
    for line in demo.denial_json:
        if '"code"' in line or '"message"' in line:
            lines.append("{error:" + line + "}")
        elif '"rule"' in line or '"reason"' in line:
            lines.append("{warn:" + line + "}")
        else:
            lines.append("{dim:" + line + "}")

    return [
        Wait(0.4),
        Emit(["{faint:# what the model receives instead}"], pause_after=0.4),
        Emit(lines, delay_between=0.07, pause_after=2.4),
    ]
