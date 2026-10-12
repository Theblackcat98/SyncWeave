"""Render captured styled spans as true-color terminal PNGs."""
import json
from PIL import Image, ImageDraw, ImageFont
from pathlib import Path

SRC = Path("docs/screenshots")
FONT_PATH = "/home/hatch/.fonts/JetBrainsMonoNerdFont-Regular.ttf"
PADDING = 28

def render(json_path: Path, font_size: int = 16):
    data = json.loads(json_path.read_text())
    lines = data["lines"]
    font = ImageFont.truetype(FONT_PATH, font_size)
    # Cell metrics from the font
    ascent, descent = font.getmetrics()
    line_h = ascent + descent + 6
    # Use a wide sample for char width (monospace, but Nerd glyphs can be wide)
    char_w = font.getlength("─" * 10) / 10
    cols = data["cols"]
    rows = len(lines)
    w = int(cols * char_w) + PADDING * 2
    h = int(rows * line_h) + PADDING * 2
    # Background from first span's bg, fallback dark
    bg0 = tuple(lines[0][0]["bg"]) if lines and lines[0] else (18, 20, 28)
    img = Image.new("RGB", (w, h), bg0)
    d = ImageDraw.Draw(img)
    y = PADDING
    for line in lines:
        x = PADDING
        for span in line:
            text = span["text"]
            fg = tuple(span["fg"])
            bg = tuple(span["bg"])
            tw = font.getlength(text)
            if bg != bg0:
                d.rectangle([x, y, x + tw, y + line_h], fill=bg)
            if text.strip():
                d.text((x, y), text, font=font, fill=fg)
            x += tw
        y += line_h
    out = json_path.with_suffix(".png")
    # Trim trailing empty rows for a tighter shot
    img.save(out)
    print(f"{out.name}: {w}x{h}")

for jf in sorted(SRC.glob("*.spans.json")):
    render(jf)

print("done")
