"""Voiceover via edge-tts.

Local, free, no API key. Audio drives the edit: each scene is rendered to
exactly the length of its line, so the picture can never drift out of sync.
"""

from __future__ import annotations

import asyncio
import json
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path


class TtsMissing(RuntimeError):
    pass


@dataclass
class Clip:
    path: Path
    speech: float
    total: float


def duration(path: Path) -> float:
    probe = shutil.which("ffprobe")
    if not probe:
        raise RuntimeError("ffprobe is not on PATH")

    result = subprocess.run(
        [probe, "-v", "quiet", "-print_format", "json", "-show_format", str(path)],
        capture_output=True,
        text=True,
        check=True,
    )
    return float(json.loads(result.stdout)["format"]["duration"])


async def _speak(text: str, voice: str, rate: str, out: Path) -> None:
    try:
        import edge_tts
    except ImportError as error:
        raise TtsMissing(
            "edge-tts is not installed. Run: pip install edge-tts, or build with --silent"
        ) from error

    await edge_tts.Communicate(text, voice, rate=rate).save(str(out))


def _pad(source: Path, seconds: float, out: Path) -> None:
    """Pads a clip with silence so it fills its scene exactly."""
    subprocess.run(
        [
            shutil.which("ffmpeg") or "ffmpeg", "-y", "-loglevel", "error",
            "-i", str(source),
            "-af", "apad",
            "-t", f"{seconds:.3f}",
            "-ar", "48000", "-ac", "2",
            str(out),
        ],
        check=True,
    )


def _silence(seconds: float, out: Path) -> None:
    subprocess.run(
        [
            shutil.which("ffmpeg") or "ffmpeg", "-y", "-loglevel", "error",
            "-f", "lavfi",
            "-i", "anullsrc=channel_layout=stereo:sample_rate=48000",
            "-t", f"{seconds:.3f}",
            str(out),
        ],
        check=True,
    )


def render(
    lines: list[str],
    tails: list[float],
    out_dir: Path,
    voice: str = "en-GB-RyanNeural",
    rate: str = "-4%",
    silent: bool = False,
) -> list[Clip]:
    """Speaks each line and pads it, returning one clip per scene."""
    out_dir.mkdir(parents=True, exist_ok=True)
    clips: list[Clip] = []

    for index, (text, tail) in enumerate(zip(lines, tails)):
        padded = out_dir / f"scene-{index:02d}.wav"

        if silent or not text.strip():
            # Fixed length when there is nothing to say, so the cut still breathes.
            total = max(tail, 2.0)
            _silence(total, padded)
            clips.append(Clip(padded, 0.0, total))
            continue

        raw = out_dir / f"scene-{index:02d}.mp3"
        asyncio.run(_speak(text, voice, rate, raw))

        speech = duration(raw)
        total = speech + tail
        _pad(raw, total, padded)
        raw.unlink(missing_ok=True)

        clips.append(Clip(padded, speech, total))
        print(f"  scene {index}: {speech:.1f}s speech, {total:.1f}s total")

    return clips


async def voices(filter_locale: str = "en-") -> list[str]:
    import edge_tts

    found = await edge_tts.list_voices()
    return sorted(v["ShortName"] for v in found if v["ShortName"].startswith(filter_locale))
