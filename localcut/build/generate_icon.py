from pathlib import Path

from PIL import Image, ImageDraw


ROOT = Path(__file__).resolve().parents[1]
SIZE = 1024
SCALE = SIZE / 128


def xy(points):
    return [(round(x * SCALE), round(y * SCALE)) for x, y in points]


canvas = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
draw = ImageDraw.Draw(canvas)
draw.rounded_rectangle(
    (6 * SCALE, 6 * SCALE, 122 * SCALE, 122 * SCALE),
    radius=30 * SCALE,
    fill="#111520",
)

l_shape = xy([(34, 31), (50, 31), (50, 81), (94, 81), (94, 97), (34, 97)])
mask = Image.new("L", (SIZE, SIZE), 0)
ImageDraw.Draw(mask).polygon(l_shape, fill=255)
gradient = Image.new("RGBA", (SIZE, SIZE))
pixels = gradient.load()
start = (121, 167, 255)
end = (108, 92, 231)
for y in range(SIZE):
    amount = y / (SIZE - 1)
    color = tuple(round(a + (b - a) * amount) for a, b in zip(start, end)) + (255,)
    for x in range(SIZE):
        pixels[x, y] = color
canvas.paste(gradient, (0, 0), mask)

draw = ImageDraw.Draw(canvas)
draw.polygon(xy([(64, 31), (94, 31), (94, 47), (80, 47), (80, 81), (64, 81)]), fill="#eef2ff")
draw.ellipse((64 * SCALE, 80 * SCALE, 80 * SCALE, 96 * SCALE), fill="#79a7ff")

assets = ROOT / "desktop" / "assets"
build = ROOT / "build"
assets.mkdir(parents=True, exist_ok=True)
build.mkdir(parents=True, exist_ok=True)
canvas.save(assets / "icon.png", optimize=True)
canvas.save(build / "icon.ico", sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)])
