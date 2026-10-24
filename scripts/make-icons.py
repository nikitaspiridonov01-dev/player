#!/usr/bin/env python3
"""Generate extension icons (app icons + monochrome toolbar template icons).

Requires Pillow:  pip install pillow
Usage:            python3 scripts/make-icons.py
"""
from pathlib import Path
from PIL import Image, ImageDraw

ROOT = Path(__file__).resolve().parent.parent / "extension" / "icons"
ROOT.mkdir(parents=True, exist_ok=True)

APP_SIZES = (48, 96, 128, 256, 512)
TOOLBAR_SIZES = (16, 19, 32, 38, 48, 72)
SCALE = 8  # supersample for smooth edges


def glyph(draw, size, color, inset=0.18, stroke_ratio=0.085):
    """AirPlay glyph: a rounded screen with a triangle in front of its bottom edge."""
    s = size
    stroke = max(1, int(s * stroke_ratio))
    left, right = s * inset, s * (1 - inset)
    top = s * (inset + 0.05)
    bottom = s * (1 - inset - 0.06)
    radius = s * 0.07
    # screen outline (we'll "cut" the bottom center for the triangle)
    draw.rounded_rectangle([left, top, right, bottom], radius=radius, outline=color, width=stroke)
    # cut-out under the triangle
    cut_w = s * 0.30
    cx = s / 2
    draw.rectangle([cx - cut_w / 2, bottom - stroke * 1.5, cx + cut_w / 2, bottom + stroke * 1.5], fill=(0, 0, 0, 0))
    # triangle
    tri_h = s * 0.22
    tri_w = s * 0.34
    apex_y = bottom - tri_h * 0.55
    base_y = bottom + tri_h * 0.45
    draw.polygon([(cx, apex_y), (cx - tri_w / 2, base_y), (cx + tri_w / 2, base_y)], fill=color)


def app_icon(size):
    big = size * SCALE
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)
    # gradient background (deep blue -> teal)
    for y in range(big):
        t = y / big
        r = int(18 + (0 - 18) * t)
        g = int(84 + (150 - 84) * t)
        b = int(200 + (210 - 200) * t)
        draw.line([(0, y), (big, y)], fill=(r, g, b, 255))
    mask = Image.new("L", (big, big), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, big - 1, big - 1], radius=int(big * 0.22), fill=255)
    img.putalpha(mask)
    layer = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    glyph(ImageDraw.Draw(layer), big, (255, 255, 255, 255))
    img = Image.alpha_composite(img, layer)
    return img.resize((size, size), Image.LANCZOS)


def toolbar_icon(size):
    big = size * SCALE
    img = Image.new("RGBA", (big, big), (0, 0, 0, 0))
    glyph(ImageDraw.Draw(img), big, (0, 0, 0, 255), inset=0.08, stroke_ratio=0.11)
    return img.resize((size, size), Image.LANCZOS)


if __name__ == "__main__":
    for s in APP_SIZES:
        app_icon(s).save(ROOT / f"icon-{s}.png")
    for s in TOOLBAR_SIZES:
        toolbar_icon(s).save(ROOT / f"toolbar-{s}.png")
    print("icons written to", ROOT)
