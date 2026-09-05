"""Build the promotional assets.

    python -m portcullis_promo gif      the short loop for the README
    python -m portcullis_promo video    the narrated explainer
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

from . import capture, encode, scenes
from .terminal import Terminal

OUT = Path(__file__).resolve().parents[1] / "out"
# The README GIF is committed, so it lands in the repo rather than in out/.
ASSETS = Path(__file__).resolve().parents[2] / "docs" / "assets"


def build_gif(args: argparse.Namespace) -> int:
    print("capturing real CLI output ...")
    demo = capture.collect()

    print("rendering frames ...")
    terminal = Terminal(width=1180, height=620, font_size=17, title="portcullis")
    frames = terminal.frames(scenes.readme_demo(demo), fps=args.fps)

    mp4 = encode.to_mp4(frames, (1180, 620), args.fps, OUT / "readme-demo.mp4")

    print("converting to gif ...")
    encode.to_gif(mp4, ASSETS / "demo.gif", fps=args.gif_fps, width=args.gif_width)

    print(f"\ndone. assets in {OUT}")
    return 0


def build_video(args: argparse.Namespace) -> int:
    from . import film

    return film.build(OUT, fps=args.fps, voice=args.voice, silent=args.silent)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="portcullis_promo", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    gif = sub.add_parser("gif", help="short terminal loop for the README")
    gif.add_argument("--fps", type=int, default=30)
    gif.add_argument("--gif-fps", type=int, default=15)
    gif.add_argument("--gif-width", type=int, default=900)
    gif.set_defaults(func=build_gif)

    video = sub.add_parser("video", help="narrated explainer")
    video.add_argument("--fps", type=int, default=30)
    video.add_argument("--voice", default="en-GB-RyanNeural")
    video.add_argument("--silent", action="store_true", help="skip narration")
    video.set_defaults(func=build_video)

    args = parser.parse_args(argv)

    try:
        return int(args.func(args))
    except (capture.BuildRequired, encode.FfmpegMissing) as error:
        print(f"error: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
