#!/usr/bin/env python3
"""Render a reel cover in the house style onto a base frame.

Style (matched to CoverPhotos/cover_09_171k.png): dark gradient over the
bottom third, small blue dash, letter-spaced uppercase kicker line, then a
big condensed uppercase headline — accent line in blue, rest in white, with
a hard drop shadow.

usage: make_cover.py <base_image> <out_png> <kicker> <accent> <headline>
"""
import os
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

BLUE = (67, 97, 238, 255)
WHITE = (255, 255, 255, 255)
SHADOW = (0, 0, 0, 160)


def first_font(*candidates):
    for candidate in candidates:
        if candidate and Path(candidate).is_file():
            return str(candidate)
    raise FileNotFoundError("No usable cover font was found. Set AEP_COVER_FONT_DIR.")


def cover_fonts():
    configured = os.environ.get("AEP_COVER_FONT_DIR", "")
    roots = [configured, "/home/claude/.local/share/fonts", "/usr/share/fonts/truetype/montserrat"]
    black = first_font(
        *(str(Path(root) / "Montserrat-Black.ttf") for root in roots if root),
        r"C:\Windows\Fonts\impact.ttf",
        r"C:\Windows\Fonts\arialbd.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    )
    bold = first_font(
        *(str(Path(root) / "Montserrat-Bold.ttf") for root in roots if root),
        r"C:\Windows\Fonts\arialbd.ttf",
        r"C:\Windows\Fonts\bahnschrift.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
    )
    return black, bold


def spaced(draw, xy, text, font, fill, tracking):
    x, y = xy
    for ch in text:
        draw.text((x, y), ch, font=font, fill=fill)
        x += draw.textlength(ch, font=font) + tracking
    return x


def shadowed(draw, xy, text, font, fill, off=6):
    draw.text((xy[0] + off, xy[1] + off), text, font=font, fill=SHADOW)
    draw.text(xy, text, font=font, fill=fill)


def fit_font(draw, text, path, max_width, start_size):
    size = start_size
    while size > 40:
        font = ImageFont.truetype(path, size)
        if draw.textlength(text, font=font) <= max_width:
            return font
        size -= 6
    return ImageFont.truetype(path, 40)


def wrap_lines(draw, text, font_path, max_width, start_size, max_lines=2):
    words = text.upper().split()
    if not words:
        return []
    for size in range(start_size, 39, -5):
        font = ImageFont.truetype(font_path, size)
        lines, current = [], ""
        for word in words:
            candidate = f"{current} {word}".strip()
            if current and draw.textlength(candidate, font=font) > max_width:
                lines.append(current)
                current = word
            else:
                current = candidate
        if current:
            lines.append(current)
        if len(lines) <= max_lines and all(draw.textlength(line, font=font) <= max_width for line in lines):
            return [(line, font) for line in lines]
    fallback = ImageFont.truetype(font_path, 40)
    return [(" ".join(words), fallback)]


def main():
    base_path, out_path, kicker, accent, headline = sys.argv[1:6]
    img = Image.open(base_path).convert("RGBA")
    W, H = img.size

    # Bottom gradient: transparent at 50% height -> strong black at bottom.
    grad = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    gd = ImageDraw.Draw(grad)
    start = int(H * 0.50)
    for y in range(start, H):
        a = int(210 * (y - start) / (H - start))
        gd.line([(0, y), (W, y)], fill=(0, 0, 0, a))
    img = Image.alpha_composite(img, grad)
    draw = ImageDraw.Draw(img)

    margin = int(W * 0.07)
    black, bold = cover_fonts()

    # Blue dash + kicker
    y = int(H * 0.565)
    draw.rectangle([margin, y, margin + int(W * 0.055), y + 8], fill=BLUE)
    y += 40
    kfont = fit_font(draw, kicker.upper(), bold, W - 2 * margin, int(H * 0.019))
    spaced(draw, (margin, y), kicker.upper(), kfont, WHITE, tracking=max(2, int(W * 0.004)))

    # Headline: accent line (blue) then remaining line(s) (white)
    y += int(H * 0.045)
    max_w = W - 2 * margin
    accent_lines = wrap_lines(draw, accent, black, max_w, int(H * 0.075), 2)
    for line, afont in accent_lines:
        shadowed(draw, (margin, y), line, afont, BLUE)
        y += int(afont.size * 1.06)
    for line, hfont in wrap_lines(draw, headline.replace("\\n", " "), black, max_w, int(H * 0.075), 2):
        shadowed(draw, (margin, y), line, hfont, WHITE)
        y += int(hfont.size * 1.06)

    img.convert("RGB").save(out_path, quality=92)
    print(out_path)


if __name__ == "__main__":
    main()
