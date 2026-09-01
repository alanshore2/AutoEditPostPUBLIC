#!/usr/bin/env python3
"""Render a screen card from a JSON spec.

usage: render_card.py <spec.json> <out_base>
       -> writes <out_base>_a.png (base) and <out_base>_b.png (highlight state)

Spec JSON:
{
  "lines": [ {"text": "## HEADER LINE", "kind": "header"},
             {"text": "", "kind": null},
             {"text": "\"context line\"", "kind": "grey"},
             {"text": "→ \"the key line\"", "kind": "hl"},     # blue in state B
             {"text": "plain line", "kind": "body"},
             {"text": "old line", "kind": "red"},              # red, struck through
             {"text": "fading...", "kind": "dim"},
             {"text": "almost gone", "kind": "dim2"} ],
  "cta": "comment KEYWORD for the full block",   # optional
  "panel": "dark"                                # or "red" (red-tinted panel)
}

Transparent canvas — the pipeline composites it over the talking head with
alpha fades. Panel is compact (tease), CTA sits under it in blue.
"""
import json
import re
import sys
import unicodedata

from PIL import Image, ImageDraw, ImageFont

W, H = 1080, 1920
PANEL = (18, 20, 27)        # 12141B
PANEL_RED = (46, 22, 25)    # E5484D tinted toward the dark panel
BODY = (232, 234, 240)      # E8EAF0
HEADER = (135, 142, 158)    # 878E9E
GREY = (135, 142, 158)
BLUE = (74, 110, 255)       # 4A6EFF
RED = (229, 72, 77)         # E5484D
DIM1 = (90, 96, 114)
DIM2 = (55, 60, 75)

MONO = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"
MONO_BOLD = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono-Bold.ttf"

LINE_H = 52
DEFAULT_CTA = ""


# --- glyph sanitize -------------------------------------------------------
# Card copy is raw LLM output. Rather than halt the batch on any novel glyph,
# map known emoji/symbols to renderable equivalents, strip glyphs the mono font
# genuinely cannot draw, and remove leaked 'CARD NN' spec scaffolding. Only a
# *meaningful* (letter) glyph the font can't draw survives, to signal an abort.

# emoji / symbol -> a glyph the mono font actually renders
SANITIZE_MAP = {
    "✅": "✓",  # ✅ -> ✓
    "✔": "✓",  # ✔ -> ✓
    "☑": "✓",  # ☑ -> ✓
    "❌": "✗",  # ❌ -> ✗
    "✖": "✗",  # ✖ -> ✗
    "★": "*",       # ★ -> *
    "➜": "→",  # ➜ -> →
    "⇒": "→",  # ⇒ -> →
    "℃": "C",       # ℃ -> C  (absent from the mono cmap)
    "℉": "F",       # ℉ -> F  (absent from the mono cmap)
}

# Glyphs the mono font draws but that live above ASCII — a floor used only when
# fontTools is unavailable. Renderability is otherwise read from the real cmap,
# never gated on a bare codepoint threshold.
_CURATED_RENDERABLE = set(
    "←↑→↓↔"  # ← ↑ → ↓ ↔
    "✓✕✗"              # ✓ ✕ ✗
    "…—–"              # … — –
    "“”‘’"        # “ ” ‘ ’
)


def _load_cmap():
    """Actual renderable codepoints from the mono font, or None if unavailable."""
    try:
        from fontTools.ttLib import TTFont
    except Exception:
        return None
    cps = set()
    for path in (MONO, MONO_BOLD):
        try:
            cps |= set(TTFont(path).getBestCmap().keys())
        except Exception:
            pass
    return cps or None


_CMAP = _load_cmap()


def _renderable(ch: str) -> bool:
    cp = ord(ch)
    if _CMAP is not None:
        return cp in _CMAP
    return cp < 0x80 or ch in _CURATED_RENDERABLE  # fallback floor, not a threshold gate


# Standalone 'CARD NN' spec label — anchored so it does NOT fire inside words
# like 'SCORECARD 3' / 'WILDCARD 2'.
_CARD_NN_RE = re.compile(r"\bCARD\s*\d+", re.IGNORECASE)


def sanitize_text(s: str):
    """Return (clean, unresolved).

    clean has emoji/symbols mapped to renderable glyphs, font-undrawable glyphs
    stripped, and leaked 'CARD NN' scaffolding removed. unresolved lists any
    *meaningful* (letter) glyph the font cannot draw that survived — callers may
    treat a non-empty list as an abort signal. Whitespace/indentation is kept
    verbatim (card layout relies on leading spaces).
    """
    s = _CARD_NN_RE.sub("", s)
    out, unresolved = [], []
    for ch in s:
        ch = SANITIZE_MAP.get(ch, ch)
        if ch == "\ufe0f":  # emoji variation selector -> drop
            continue
        if ch in " \t\n" or _renderable(ch):
            out.append(ch)
        elif unicodedata.category(ch).startswith("L"):
            unresolved.append(ch)  # meaningful glyph the font can't draw; don't emit tofu
        # else: decorative symbol / pictograph (🚩 🔍 …) -> silently dropped
    return "".join(out), unresolved


def sanitize_spec(spec: dict) -> dict:
    """Sanitize every drawable text field of a card spec in place; abort only if
    a meaningful non-renderable glyph survives sanitizing."""
    bad = []
    for line in spec.get("lines", []):
        clean, unresolved = sanitize_text(line.get("text", ""))
        line["text"] = clean
        bad += unresolved
    if spec.get("cta") is not None:
        clean, unresolved = sanitize_text(spec["cta"])
        spec["cta"] = clean
        bad += unresolved
    if bad:
        glyphs = " ".join(f"U+{ord(c):04X}({c})" for c in dict.fromkeys(bad))
        sys.stderr.write(
            f"render_card: non-renderable glyph(s) survived sanitize: {glyphs}\n"
        )
        sys.exit(3)
    return spec


def _selfcheck() -> None:
    clean, unres = sanitize_text("Deploy ✅ done ❌ ➜ next CARD 3")
    assert "✅" not in clean and "✓" in clean, clean   # ✅ -> ✓
    assert "❌" not in clean and "✗" in clean, clean   # ❌ -> ✗
    assert "→" in clean, clean                              # ➜ normalized to →
    assert "CARD 3" not in clean, clean                         # scaffolding stripped
    assert not unres, unres
    hot, _ = sanitize_text("Heat 100℃ / 212℉")
    assert "℃" not in hot and "100C" in hot, hot           # ℃ -> C
    assert "℉" not in hot and "212F" in hot, hot           # ℉ -> F
    keep, _ = sanitize_text("SCORECARD 3 rules")                # anchored: must NOT strip
    assert "SCORECARD 3" in keep, keep
    deco, _ = sanitize_text("win \U0001F6A9 look \U0001F50D here")  # 🚩 🔍 dropped, text kept
    assert "\U0001F6A9" not in deco and "win" in deco and "here" in deco, deco
    print("selfcheck OK")


def render(spec: dict, out_path: str, highlight: bool) -> None:
    lines = spec["lines"]
    cta = spec.get("cta", DEFAULT_CTA)
    panel_fill = PANEL_RED if spec.get("panel") == "red" else PANEL

    img = Image.new("RGBA", (W, H), (0, 0, 0, 0))

    body_f = ImageFont.truetype(MONO, 34)
    header_f = ImageFont.truetype(MONO_BOLD, 28)

    pw = 900
    px = (W - pw) // 2
    content_h = len(lines) * LINE_H + 150
    py = 260

    panel = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    pd = ImageDraw.Draw(panel)
    pd.rounded_rectangle(
        [px + 10, py + 14, px + pw + 10, py + content_h + 14], 24, fill=(0, 0, 0, 110)
    )
    pd.rounded_rectangle(
        [px, py, px + pw, py + content_h], 20,
        fill=panel_fill + (242,), outline=(255, 255, 255, 28), width=2,
    )
    img = Image.alpha_composite(img, panel)
    draw = ImageDraw.Draw(img)

    y = py + 55
    for line in lines:
        text, kind = line.get("text", ""), line.get("kind")
        if kind == "header":
            x = px + 60
            for ch in text.upper():
                draw.text((x, y), ch, font=header_f, fill=HEADER)
                x += draw.textlength(ch, font=header_f) + 3
        elif kind:
            color = {
                "grey": GREY,
                "body": BODY,
                "hl": BLUE if highlight else BODY,
                "red": RED,
                "dim": DIM1,
                "dim2": DIM2,
            }.get(kind, BODY)
            if kind == "hl" and highlight:
                glow = Image.new("RGBA", (W, H), (0, 0, 0, 0))
                gd = ImageDraw.Draw(glow)
                for dx, dy in ((-2, 0), (2, 0), (0, -2), (0, 2)):
                    gd.text((px + 60 + dx, y + dy), text, font=body_f, fill=BLUE + (60,))
                img = Image.alpha_composite(img, glow)
                draw = ImageDraw.Draw(img)
            draw.text((px + 60, y), text, font=body_f, fill=color)
            if kind == "red":
                tw = draw.textlength(text, font=body_f)
                draw.line([px + 60, y + 20, px + 60 + tw, y + 20], fill=RED, width=3)
        y += LINE_H

    if cta:
        cta_f = ImageFont.truetype(MONO_BOLD, 38)
        cw = draw.textlength(cta, font=cta_f)
        draw.text(((W - cw) / 2, y + 30), cta, font=cta_f, fill=BLUE)

    img.save(out_path)
    print(out_path)


if __name__ == "__main__":
    if len(sys.argv) >= 2 and sys.argv[1] == "--selfcheck":
        _selfcheck()
        sys.exit(0)
    spec = sanitize_spec(json.load(open(sys.argv[1])))
    base = sys.argv[2].removesuffix(".png")
    render(spec, base + "_a.png", highlight=False)
    render(spec, base + "_b.png", highlight=True)
