# promo

Builds the demo GIF and the narrated explainer for Portcullis.

Nothing here is typed out by hand. The terminal scenes run the real CLI and
animate its actual output, and the dashboard scenes are screenshots of the real
dashboard driven by Playwright. If the tool changes, rebuild and the assets
change with it. A promo that drifts from the product is worse than no promo.

## Build

The core has to be built first, since the pipeline runs it:

```sh
cd ../core && npm install && npm run build
```

Then:

```sh
cd promo
pip install -r requirements.txt
playwright install chromium

python -m portcullis_promo gif     # short loop, writes docs/assets/demo.gif
python -m portcullis_promo video   # narrated explainer, writes out/portcullis.mp4
```

`--silent` skips narration if you only want the picture. `--voice` picks a
different one:

```sh
python -c "import asyncio;from portcullis_promo.narrate import voices;print('\n'.join(asyncio.run(voices())))"
```

## Requirements

- **ffmpeg** and **ffprobe** on PATH, for encoding and duration probing
- **Playwright** with Chromium, for the dashboard screenshots
- **edge-tts** for narration, which is local, free and needs no API key
- A monospace font. Cascadia Mono, Consolas, DejaVu Sans Mono and Menlo are all
  found automatically; see `theme.py` to add another.

## How it fits together

| Module | Job |
|--------|-----|
| `capture.py` | Runs the real CLI under a temporary `PORTCULLIS_HOME` and returns its output |
| `dashboard.py` | Seeds a gated session, serves it, screenshots the real UI |
| `terminal.py` | Renders a terminal session to frames, with typing and colour markup |
| `effects.py` | The perspective panel flip, wipes, easing |
| `narrate.py` | Speaks each line and pads it to its scene length |
| `scenes.py` | Turns captured output into scene events |
| `film.py` | The script, and the assembly |
| `encode.py` | Pipes frames to ffmpeg, then makes the GIF two-pass |

Audio is cut before the picture. Each scene is rendered to exactly the length of
its narration line, so the two cannot drift apart no matter how the script
changes.

## Output

`out/` is ignored by git. The one committed asset is `docs/assets/demo.gif`,
because the README needs it to render on GitHub. The full video is large enough
that it belongs on a release rather than in the tree.
