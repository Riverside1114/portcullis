"""Frames to video, and video to GIF.

Frames are piped to ffmpeg as raw RGB rather than written out as thousands of
PNGs, which keeps a sixty second render from touching the disk at all.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path
from typing import Iterable

from PIL import Image


class FfmpegMissing(RuntimeError):
    pass


def _ffmpeg() -> str:
    found = shutil.which("ffmpeg")
    if not found:
        raise FfmpegMissing("ffmpeg is not on PATH. Install it and try again.")
    return found


def to_mp4(
    frames: Iterable[Image.Image],
    size: tuple[int, int],
    fps: int,
    out: Path,
    audio: Path | None = None,
) -> Path:
    out.parent.mkdir(parents=True, exist_ok=True)

    command = [
        _ffmpeg(),
        "-y",
        "-loglevel", "error",
        "-f", "rawvideo",
        "-pix_fmt", "rgb24",
        "-s", f"{size[0]}x{size[1]}",
        "-r", str(fps),
        "-i", "-",
    ]

    if audio is not None:
        command += ["-i", str(audio), "-c:a", "aac", "-b:a", "192k", "-shortest"]

    command += [
        "-c:v", "libx264",
        "-preset", "medium",
        "-crf", "18",
        # yuv420p, or the file will not play in browsers or on phones.
        "-pix_fmt", "yuv420p",
        "-movflags", "+faststart",
        str(out),
    ]

    process = subprocess.Popen(command, stdin=subprocess.PIPE)
    assert process.stdin is not None

    count = 0
    try:
        for frame in frames:
            if frame.size != size:
                frame = frame.resize(size, Image.LANCZOS)
            process.stdin.write(frame.convert("RGB").tobytes())
            count += 1
    finally:
        process.stdin.close()
        process.wait()

    if process.returncode != 0:
        raise RuntimeError(f"ffmpeg failed with exit code {process.returncode}")

    print(f"  {out.name}: {count} frames, {count / fps:.1f}s, {out.stat().st_size / 1e6:.1f} MB")
    return out


def to_gif(source: Path, out: Path, fps: int = 15, width: int = 900) -> Path:
    """Two pass palette, because a single pass GIF of a dark terminal bands badly."""
    out.parent.mkdir(parents=True, exist_ok=True)
    palette = out.with_suffix(".palette.png")

    filters = f"fps={fps},scale={width}:-1:flags=lanczos"

    subprocess.run(
        [_ffmpeg(), "-y", "-loglevel", "error", "-i", str(source),
         "-vf", f"{filters},palettegen=stats_mode=diff", str(palette)],
        check=True,
    )
    subprocess.run(
        [_ffmpeg(), "-y", "-loglevel", "error", "-i", str(source), "-i", str(palette),
         "-lavfi", f"{filters}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3",
         str(out)],
        check=True,
    )

    palette.unlink(missing_ok=True)
    print(f"  {out.name}: {out.stat().st_size / 1e6:.1f} MB")
    return out


def concat_audio(parts: list[Path], out: Path) -> Path:
    """Joins narration clips end to end, keeping the gaps that were rendered in."""
    out.parent.mkdir(parents=True, exist_ok=True)
    listing = out.with_suffix(".txt")
    listing.write_text(
        "\n".join(f"file '{p.as_posix()}'" for p in parts) + "\n", encoding="utf-8"
    )

    subprocess.run(
        [_ffmpeg(), "-y", "-loglevel", "error", "-f", "concat", "-safe", "0",
         "-i", str(listing), "-c", "copy", str(out)],
        check=True,
    )

    listing.unlink(missing_ok=True)
    return out
