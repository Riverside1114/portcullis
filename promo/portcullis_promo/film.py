"""The narrated explainer.

Audio is cut first and the picture is rendered to fit it, so narration and
frames cannot drift apart.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path
from typing import Callable, Iterator

from PIL import Image

from . import capture, dashboard, effects, encode, narrate, scenes, theme
from .terminal import Emit, Event, Terminal, Typed, Wait

CANVAS = (1920, 1080)


@dataclass
class Scene:
    say: str
    render: Callable[[float, int], Iterator[Image.Image]]
    tail: float = 0.5
    label: str = ""


def _frames_for(seconds: float, fps: int) -> int:
    return max(1, round(seconds * fps))


def _still(image: Image.Image) -> Callable[[float, int], Iterator[Image.Image]]:
    def render(seconds: float, fps: int) -> Iterator[Image.Image]:
        for _ in range(_frames_for(seconds, fps)):
            yield image

    return render


def _card(heading: str, lines: list[str], wipe: float = 0.7):
    def render(seconds: float, fps: int) -> Iterator[Image.Image]:
        total = _frames_for(seconds, fps)
        wipe_frames = min(total, _frames_for(wipe, fps))
        for index in range(total):
            reveal = 1.0 if index >= wipe_frames else index / max(1, wipe_frames)
            yield effects.title_card(CANVAS, heading, lines, reveal)

    return render


def _terminal(events: list[Event], width: int = 1500, height: int = 800, font: int = 19):
    """Renders a terminal session centred on the canvas, holding the last frame."""

    def render(seconds: float, fps: int) -> Iterator[Image.Image]:
        term = Terminal(width=width, height=height, font_size=font)
        produced: list[Image.Image] = list(term.frames(events, fps))
        total = _frames_for(seconds, fps)

        for index in range(total):
            source = produced[min(index, len(produced) - 1)]
            frame = Image.new("RGB", CANVAS, theme.BG)
            panel = effects.rounded(source, 12)
            frame.paste(panel, ((CANVAS[0] - panel.width) // 2, (CANVAS[1] - panel.height) // 2))
            yield frame

    return render


def _flip(front: Image.Image, back: Image.Image, spin: float = 1.15):
    """Rotates one panel away and the next into place, then holds it."""

    def render(seconds: float, fps: int) -> Iterator[Image.Image]:
        total = _frames_for(seconds, fps)
        spin_frames = min(total, _frames_for(spin, fps))

        for index in range(total):
            if index >= spin_frames:
                yield effects.flip(front, back, 180.0, CANVAS)
                continue
            angle = 180.0 * effects.ease_in_out(index / max(1, spin_frames))
            yield effects.flip(front, back, angle, CANVAS)

    return render


def build(out: Path, fps: int = 30, voice: str = "en-GB-RyanNeural", silent: bool = False) -> int:
    print("capturing real CLI output ...")
    demo = capture.collect()

    print("screenshotting the real dashboard ...")
    shots = dashboard.screenshots(out / "shots")

    wrap_config = [
        Wait(0.3),
        Emit(['{faint:# claude_desktop_config.json}'], pause_after=0.3),
        Emit(
            [
                '{dim:"filesystem": \\{}',
                '{error:-   "command": "npx",}',
                '{ok:+   "command": "portcullis",}',
                '{ok:+   "args": ["run", "--policy", "fs.yaml", "--",}',
                '{ok:+           "npx", "-y", "@modelcontextprotocol/server-filesystem", "~"]}',
                '{dim:\\}}',
            ],
            delay_between=0.28,
            pause_after=1.0,
        ),
    ]

    tail_view = [
        Wait(0.3),
        Typed("portcullis tail filesystem", cps=48),
        Emit(scenes._colour_tail(demo.tail), delay_between=0.12, pause_after=1.4),
    ]

    # Sized to its content: a tall, mostly empty panel reads as a mistake
    # once it is rotating in three dimensions.
    terminal_still = Terminal(width=1500, height=470, font_size=19)
    list(terminal_still.frames(tail_view, fps))
    tail_image = effects.rounded(terminal_still.draw(), 12)

    script: list[Scene] = [
        Scene(
            label="hook",
            say="Your A I agent can read your filesystem, reach your internal A P Is, "
            "and send mail on your behalf.",
            render=_card(
                "Your agent can do a lot.",
                ["Read your files.", "Reach your internal APIs.", "Send mail as you."],
            ),
            tail=0.6,
        ),
        Scene(
            label="problem",
            say="You have no record of any of it, and nothing enforcing what it may touch.",
            render=_card(
                "You have no record of any of it.",
                ["No log of the call that deleted the file.",
                 "No boundary on a server you were told only reads."],
            ),
            tail=0.6,
        ),
        Scene(
            label="wrap",
            say="Portcullis is a proxy that speaks the Model Context Protocol on both sides. "
            "You change one line of config. Everything after the dashes is your original command.",
            render=_terminal(wrap_config),
            tail=0.7,
        ),
        Scene(
            label="record",
            say="Now every call is on disk. A raw reply carries only an id, so Portcullis "
            "matches it back to the request and stamps it with the method and how long it took.",
            render=_terminal(tail_view),
            tail=0.7,
        ),
        Scene(
            label="dashboard",
            say="Or read it in the browser. A live feed, latency per method, error rates, "
            "and the full payload of any call. It binds to localhost only.",
            render=_flip(tail_image, shots["overview"]),
            tail=0.8,
        ),
        Scene(
            label="policy",
            say="Recording tells you what happened. A policy decides what is allowed to.",
            render=_terminal(scenes.policy_scene(demo), width=1200, height=780, font=20),
            tail=0.6,
        ),
        Scene(
            label="denied",
            say="A denied call never reaches the server. Here are three attempts to read "
            "credentials, all stopped at the gate.",
            render=_flip(shots["overview"], shots["denied"]),
            tail=0.8,
        ),
        Scene(
            label="error",
            say="The agent gets a proper error in its place, worded so the model looks for "
            "another route instead of retrying the same blocked call.",
            render=_terminal(scenes.denial_scene(demo), width=1500, height=820, font=18),
            tail=0.9,
        ),
        Scene(
            label="close",
            say="Portcullis. A firewall and flight recorder for A I tool calls. "
            "M I T licensed, zero runtime dependencies, and nothing ever leaves your machine.",
            render=_card(
                "Portcullis",
                [
                    "A firewall and flight recorder for AI tool calls.",
                    "",
                    "MIT  ·  zero runtime dependencies  ·  nothing leaves your machine",
                    "github.com/Riverside1114/portcullis",
                ],
            ),
            tail=1.6,
        ),
    ]

    print("speaking the script ...")
    clips = narrate.render(
        [scene.say for scene in script],
        [scene.tail for scene in script],
        out / "audio",
        voice=voice,
        silent=silent,
    )

    print("rendering frames ...")

    def all_frames() -> Iterator[Image.Image]:
        for scene, clip in zip(script, clips):
            print(f"  {scene.label} ({clip.total:.1f}s)")
            yield from scene.render(clip.total, fps)

    track = encode.concat_audio([clip.path for clip in clips], out / "audio" / "narration.wav")
    encode.to_mp4(all_frames(), CANVAS, fps, out / "portcullis.mp4", audio=track)

    print(f"\ndone. film in {out / 'portcullis.mp4'}")
    return 0
