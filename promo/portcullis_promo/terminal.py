"""Renders a terminal session as animated frames.

The content comes from `capture.py`, which runs the real commands, so the demo
cannot drift away from what the tool actually does.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Iterator, Sequence

from PIL import Image, ImageDraw

from . import theme

Span = tuple[str, str]
Line = list[Span]

# Colour markup used in scripted lines: {ok:passed} renders "passed" in green.
MARKUP = re.compile(r"\{(\w+):((?:[^{}]|\{[^{}]*\})*)\}")


def spans(text: str, default: str = "text") -> Line:
    """Turns "a {error:bad} c" into coloured spans."""
    out: Line = []
    cursor = 0
    for match in MARKUP.finditer(text):
        if match.start() > cursor:
            out.append((text[cursor : match.start()], default))
        colour = match.group(1)
        out.append((match.group(2), colour if colour in theme.PALETTE else default))
        cursor = match.end()
    if cursor < len(text):
        out.append((text[cursor:], default))
    return out or [("", default)]


def plain(line: Line) -> str:
    return "".join(text for text, _ in line)


@dataclass
class Typed:
    """A command typed at the prompt, one character at a time."""

    text: str
    prompt: str = "$ "
    cps: float = 42.0
    pause_after: float = 0.35


@dataclass
class Emit:
    """Output appearing. Instant by default, which is how real output behaves."""

    lines: Sequence[str]
    delay_between: float = 0.0
    pause_after: float = 0.0


@dataclass
class Wait:
    seconds: float


@dataclass
class Clear:
    pass


Event = Typed | Emit | Wait | Clear


@dataclass
class Terminal:
    width: int = 1400
    height: int = 760
    font_size: int = 22
    padding: int = 26
    title: str = "portcullis"
    scale: int = 1
    _lines: list[Line] = field(default_factory=list, init=False)

    def __post_init__(self) -> None:
        self.font = theme.mono(self.font_size * self.scale)
        self.title_font = theme.sans(13 * self.scale)
        box = self.font.getbbox("M")
        self.char_w = box[2] - box[0]
        self.line_h = int(self.font_size * self.scale * 1.55)
        self.chrome_h = 38 * self.scale
        self._visible = (self.height * self.scale - self.chrome_h - 2 * self.padding * self.scale) // self.line_h

    # -- frame production ----------------------------------------------------

    def frames(self, events: Sequence[Event], fps: int) -> Iterator[Image.Image]:
        for event in events:
            yield from self._run(event, fps)

    def _run(self, event: Event, fps: int) -> Iterator[Image.Image]:
        if isinstance(event, Clear):
            self._lines = []
            yield self.draw()
            return

        if isinstance(event, Wait):
            yield from self._hold(event.seconds, fps)
            return

        if isinstance(event, Typed):
            self._lines.append(spans(event.prompt, "accent"))
            for index in range(1, len(event.text) + 1):
                self._lines[-1] = spans(event.prompt, "accent") + [(event.text[:index], "text")]
                yield from self._hold(1.0 / event.cps, fps, cursor=True)
            yield from self._hold(event.pause_after, fps, cursor=True)
            return

        for raw in event.lines:
            self._lines.append(spans(raw))
            if event.delay_between > 0:
                yield from self._hold(event.delay_between, fps)
        if event.delay_between == 0:
            yield self.draw()
        yield from self._hold(event.pause_after, fps)

    def _hold(self, seconds: float, fps: int, cursor: bool = False) -> Iterator[Image.Image]:
        count = max(0, round(seconds * fps))
        for index in range(count):
            # Blink at roughly 2 Hz so the terminal looks alive while waiting.
            show = cursor and (index // max(1, fps // 4)) % 2 == 0
            yield self.draw(cursor=show)

    # -- drawing -------------------------------------------------------------

    def draw(self, cursor: bool = False) -> Image.Image:
        s = self.scale
        image = Image.new("RGB", (self.width * s, self.height * s), theme.BG)
        canvas = ImageDraw.Draw(image)

        canvas.rectangle([0, 0, self.width * s, self.chrome_h], fill=theme.RAISED)
        canvas.line([0, self.chrome_h, self.width * s, self.chrome_h], fill=theme.LINE, width=s)

        for index, colour in enumerate(((229, 83, 75), (216, 161, 58), (70, 185, 120))):
            cx = (18 + index * 18) * s
            cy = self.chrome_h // 2
            r = 5 * s
            canvas.ellipse([cx - r, cy - r, cx + r, cy + r], fill=colour)

        canvas.text(
            (self.width * s // 2, self.chrome_h // 2),
            self.title,
            font=self.title_font,
            fill=theme.FAINT,
            anchor="mm",
        )

        top = self.chrome_h + self.padding * s
        left = self.padding * s

        for row, line in enumerate(self._lines[-self._visible :]):
            x = left
            y = top + row * self.line_h
            for text, colour in line:
                canvas.text((x, y), text, font=self.font, fill=theme.PALETTE[colour])
                x += self.char_w * len(text)
            if cursor and row == len(self._lines[-self._visible :]) - 1:
                canvas.rectangle(
                    [x + 2 * s, y + 3 * s, x + self.char_w + 2 * s, y + self.line_h - 6 * s],
                    fill=theme.ACCENT,
                )

        return image


def strip_ansi(text: str) -> str:
    return re.sub(r"\x1b\[[0-9;]*m", "", text)
