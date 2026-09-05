"""Frame transforms: the panel flip, fades, and easing."""

from __future__ import annotations

import math

import numpy as np
from PIL import Image, ImageDraw, ImageFilter, ImageOps

from . import theme


def ease_in_out(t: float) -> float:
    t = max(0.0, min(1.0, t))
    return 3 * t * t - 2 * t * t * t


def ease_out(t: float) -> float:
    t = max(0.0, min(1.0, t))
    return 1 - (1 - t) ** 3


def _coeffs(dst: list[tuple[float, float]], src: list[tuple[float, float]]) -> list[float]:
    """Solves the perspective coefficients Pillow needs.

    Pillow maps output pixels back to input pixels, so the system is built from
    destination points to source points, not the other way round.
    """
    rows = []
    values = []
    for (x, y), (u, v) in zip(dst, src):
        rows.append([x, y, 1, 0, 0, 0, -u * x, -u * y])
        rows.append([0, 0, 0, x, y, 1, -v * x, -v * y])
        values.extend([u, v])

    solution = np.linalg.solve(np.array(rows, dtype=float), np.array(values, dtype=float))
    return solution.tolist()


def flip(
    front: Image.Image,
    back: Image.Image,
    angle_deg: float,
    canvas: tuple[int, int],
    background: tuple[int, int, int] = theme.BG,
    fill: float = 0.78,
) -> Image.Image:
    """One frame of a panel rotating about its vertical axis.

    The texture swaps as the panel passes edge on, so the rotation reveals the
    second image rather than the back of the first.
    """
    radians = math.radians(angle_deg)
    cosine = math.cos(radians)
    sine = math.sin(radians)

    # Past ninety degrees the quad itself mirrors the texture, so the back is
    # pre-mirrored to cancel that out and land the right way round.
    texture = front if cosine >= 0 else ImageOps.mirror(back)
    out = Image.new("RGB", canvas, background)

    # Edge on, nothing is visible. Drawing it would divide by a vanishing width.
    if abs(cosine) < 0.02:
        return out

    panel_w = canvas[0] * fill
    panel_h = panel_w * texture.height / texture.width
    if panel_h > canvas[1] * fill:
        panel_h = canvas[1] * fill
        panel_w = panel_h * texture.width / texture.height

    half_w, half_h = panel_w / 2, panel_h / 2
    cx, cy = canvas[0] / 2, canvas[1] / 2
    focal = half_w * 2.6

    corners: list[tuple[float, float]] = []
    for sx, sy in ((-1, -1), (1, -1), (1, 1), (-1, 1)):
        x3 = sx * half_w * cosine
        z3 = sx * half_w * sine
        scale = focal / (focal + z3)
        corners.append((cx + x3 * scale, cy + sy * half_h * scale))

    source = [
        (0.0, 0.0),
        (float(texture.width), 0.0),
        (float(texture.width), float(texture.height)),
        (0.0, float(texture.height)),
    ]

    warped = texture.convert("RGBA").transform(
        canvas,
        Image.PERSPECTIVE,
        _coeffs(corners, source),
        resample=Image.BICUBIC,
    )

    # Anything outside the quad comes back as transparent black; mask it so the
    # background shows through cleanly.
    mask = Image.new("L", canvas, 0)
    ImageDraw.Draw(mask).polygon(corners, fill=255)

    shadow = Image.new("RGB", canvas, (0, 0, 0))
    out.paste(shadow, (0, 0), mask.filter(ImageFilter.GaussianBlur(18)).point(lambda v: v // 3))
    out.paste(warped.convert("RGB"), (0, 0), mask)

    return out


def fade(image: Image.Image, amount: float, background: tuple[int, int, int] = theme.BG) -> Image.Image:
    amount = max(0.0, min(1.0, amount))
    return Image.blend(Image.new("RGB", image.size, background), image.convert("RGB"), amount)


def rounded(image: Image.Image, radius: int = 14) -> Image.Image:
    mask = Image.new("L", image.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, image.size[0] - 1, image.size[1] - 1], radius, fill=255)
    out = Image.new("RGB", image.size, theme.BG)
    out.paste(image.convert("RGB"), (0, 0), mask)
    return out


def title_card(
    canvas: tuple[int, int],
    heading: str,
    lines: list[str],
    reveal: float = 1.0,
) -> Image.Image:
    """Large text on the background, wiped in from the left."""
    image = Image.new("RGB", canvas, theme.BG)
    draw = ImageDraw.Draw(image)

    heading_font = theme.sans_bold(int(canvas[1] * 0.062))
    body_font = theme.sans(int(canvas[1] * 0.034))

    total_h = heading_font.size * 1.5 + len(lines) * body_font.size * 1.55
    y = (canvas[1] - total_h) / 2

    draw.text((canvas[0] * 0.11, y), heading, font=heading_font, fill=theme.TEXT)
    y += heading_font.size * 1.5

    for line in lines:
        draw.text((canvas[0] * 0.11, y), line, font=body_font, fill=theme.DIM)
        y += body_font.size * 1.55

    if reveal >= 1.0:
        return image

    # A wipe rather than a fade: text stays crisp the whole way in.
    cut = int(canvas[0] * ease_out(reveal))
    out = Image.new("RGB", canvas, theme.BG)
    out.paste(image.crop((0, 0, cut, canvas[1])), (0, 0))
    return out
