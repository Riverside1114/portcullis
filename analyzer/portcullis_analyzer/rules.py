"""Loading and compiling rule packs.

Rules live in YAML so that adding a detection does not mean touching Python.
Anything malformed is an error naming the rule, never a rule that silently
never fires.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable

import yaml

# Inside the package, so an installed copy ships them and there is only one
# place a rule can live.
BUILTIN_DIR = Path(__file__).resolve().parent / "rules_data"

SEVERITIES = ("low", "medium", "high", "critical")


class RuleError(ValueError):
    pass


@dataclass(frozen=True)
class SecretRule:
    id: str
    name: str
    severity: str
    regex: re.Pattern[str]
    #: Minimum bits per character for the captured value, or None to skip the check.
    entropy: float | None


@dataclass(frozen=True)
class InjectionRule:
    id: str
    name: str
    weight: int
    regex: re.Pattern[str]


@dataclass
class Packs:
    secrets: tuple[SecretRule, ...] = ()
    injection: tuple[InjectionRule, ...] = ()
    threshold: int = 5

    def __len__(self) -> int:
        return len(self.secrets) + len(self.injection)


def load(paths: Iterable[Path] | None = None) -> Packs:
    """Loads rule packs, defaulting to the ones that ship with the analyzer."""
    files = list(paths) if paths is not None else sorted(BUILTIN_DIR.glob("*.yaml"))
    if not files:
        raise RuleError(f"no rule packs found in {BUILTIN_DIR}")

    secrets: list[SecretRule] = []
    injection: list[InjectionRule] = []
    threshold = 5
    seen: set[str] = set()

    for path in files:
        document = yaml.safe_load(path.read_text(encoding="utf-8"))
        if not isinstance(document, dict):
            raise RuleError(f"{path.name}: expected a mapping at the top level")

        kind = document.get("kind")
        if kind not in ("secrets", "injection"):
            raise RuleError(f"{path.name}: kind must be secrets or injection, got {kind!r}")

        if kind == "injection" and "threshold" in document:
            threshold = int(document["threshold"])

        for index, raw in enumerate(document.get("rules") or []):
            where = f"{path.name}[{index}]"
            rule_id = _text(raw, "id", where)

            if rule_id in seen:
                raise RuleError(f"{where}: duplicate rule id {rule_id!r}")
            seen.add(rule_id)

            regex = _compile(_text(raw, "pattern", where), f"{where} ({rule_id})")

            if kind == "secrets":
                severity = raw.get("severity", "medium")
                if severity not in SEVERITIES:
                    raise RuleError(
                        f"{where} ({rule_id}): severity must be one of {', '.join(SEVERITIES)}"
                    )
                entropy = raw.get("entropy")
                secrets.append(
                    SecretRule(
                        id=rule_id,
                        name=_text(raw, "name", where),
                        severity=severity,
                        regex=regex,
                        entropy=float(entropy) if entropy is not None else None,
                    )
                )
            else:
                injection.append(
                    InjectionRule(
                        id=rule_id,
                        name=_text(raw, "name", where),
                        weight=int(raw.get("weight", 1)),
                        regex=regex,
                    )
                )

    return Packs(tuple(secrets), tuple(injection), threshold)


def _text(raw: object, key: str, where: str) -> str:
    if not isinstance(raw, dict):
        raise RuleError(f"{where}: expected a mapping")
    value = raw.get(key)
    if not isinstance(value, str) or not value.strip():
        raise RuleError(f"{where}: {key} is required and must be a non-empty string")
    return value


def _compile(pattern: str, where: str) -> re.Pattern[str]:
    try:
        return re.compile(pattern)
    except re.error as error:
        raise RuleError(f"{where}: pattern does not compile, {error}") from error
