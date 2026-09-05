"""Colours and fonts, kept in step with the dashboard so the assets match."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from PIL import ImageFont

RGB = tuple[int, int, int]

BG: RGB = (14, 17, 22)
RAISED: RGB = (22, 27, 34)
INSET: RGB = (11, 14, 19)
LINE: RGB = (35, 42, 53)
TEXT: RGB = (216, 222, 233)
DIM: RGB = (139, 152, 171)
FAINT: RGB = (92, 104, 121)
ACCENT: RGB = (76, 154, 255)
OK: RGB = (70, 185, 120)
WARN: RGB = (216, 161, 58)
ERROR: RGB = (229, 83, 75)

PALETTE: dict[str, RGB] = {
    "text": TEXT,
    "dim": DIM,
    "faint": FAINT,
    "accent": ACCENT,
    "ok": OK,
    "warn": WARN,
    "error": ERROR,
}

# Ordered by preference. Cascadia Mono ships with Windows Terminal, DejaVu with
# most Linux distributions, Menlo with macOS.
MONO_CANDIDATES = (
    "CascadiaMono.ttf",
    "consola.ttf",
    "DejaVuSansMono.ttf",
    "Menlo.ttc",
    "cour.ttf",
)

SANS_CANDIDATES = (
    "segoeui.ttf",
    "DejaVuSans.ttf",
    "Helvetica.ttc",
    "arial.ttf",
)

SANS_BOLD_CANDIDATES = (
    "segoeuib.ttf",
    "DejaVuSans-Bold.ttf",
    "Helvetica.ttc",
    "arialbd.ttf",
)

FONT_DIRS = (
    Path("C:/Windows/Fonts"),
    Path("/usr/share/fonts/truetype/dejavu"),
    Path("/usr/share/fonts/truetype"),
    Path("/Library/Fonts"),
    Path("/System/Library/Fonts"),
)


class FontMissing(RuntimeError):
    pass


def _find(candidates: tuple[str, ...]) -> Path:
    for name in candidates:
        for directory in FONT_DIRS:
            path = directory / name
            if path.exists():
                return path
    raise FontMissing(
        f"none of {', '.join(candidates)} were found. Install one, or add its "
        f"directory to FONT_DIRS in theme.py."
    )


def mono(size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(str(_find(MONO_CANDIDATES)), size)


def sans(size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(str(_find(SANS_CANDIDATES)), size)


def sans_bold(size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(str(_find(SANS_BOLD_CANDIDATES)), size)


@dataclass(frozen=True)
class Video:
    width: int = 1920
    height: int = 1080
    fps: int = 30

    @property
    def size(self) -> tuple[int, int]:
        return (self.width, self.height)


VIDEO = Video()
