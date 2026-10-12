"""Render captured TUI text frames as terminal-style PNG screenshots."""
from PIL import Image, ImageDraw, ImageFont
from pathlib import Path

SRC = Path("docs/screenshots")
FONT_PATH = "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf"
# Fallback for Nerd Font glyphs / braille: DejaVu covers most; missing glyphs render as boxes.
BG = (18, 20, 28)
FG = (220, 224, 235)
PADDING = 24

def render(txt_path: Path, out_path: Path, font_size: int = 15):
    lines = txt_path.read_text().split("\n")
    # Drop trailing empty lines, keep the frame tight
    while lines and not lines[-1].strip():
        lines.pop()
    font = ImageFont.truetype(FONT_PATH, font_size)
    # Measure with a representative wide char
    bbox = font.getbbox("█" * 120)
    char_w = (bbox[2] - bbox[0]) / 120
    line_h = font.getbbox("█")[3] - font.getbbox("█")[1] + 8
    max_len = max(len(l) for l in lines)
    w = int(max_len * char_w) + PADDING * 2
    h = int(len(lines) * line_h) + PADDING * 2
    img = Image.new("RGB", (w, h), BG)
    d = ImageDraw.Draw(img)
    y = PADDING
    for line in lines:
        d.text((PADDING, y), line, font=font, fill=FG)
        y += line_h
    img.save(out_path)
    print(f"{out_path.name}: {w}x{h}")

for txt in sorted(SRC.glob("*.txt")):
    render(txt, txt.with_suffix(".png"))

print("done")
