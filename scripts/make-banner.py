"""Builds the animated README banner, assets/banner.svg.

Usage: python3 scripts/make-banner.py <Fraunces variable woff2> assets/banner.svg

Fraunces is embedded in the SVG because GitHub shows README images without loading web fonts.
The latin wght file from @fontsource-variable/fraunces works (fraunces-latin-wght-normal.woff2, about 37 KB).
"""

import base64
import math
import sys
from pathlib import Path

FONT_PATH, OUT_PATH = Path(sys.argv[1]), Path(sys.argv[2])
FONT_DATA = base64.b64encode(FONT_PATH.read_bytes()).decode()

WIDTH, HEIGHT = 1280, 320
CORAL, ROSE, JADE = "#e8775a", "#b0628f", "#4a8c6f"
CLAY, INK = "#D97757", "#1F1E1D"
PRIDE = ["#E40303", "#FF8C00", "#FFED00", "#008026", "#24408E", "#732982"]
MODS = ["progress", "cache-tax", "filetree", "reflect"]

BAR_X, BAR_Y, BAR_W, CELL, ROWS = 120, 256, 1040, 8, 3
WORDMARK_Y, TAG_Y = 128, 176
CYCLE = 12  # seconds per loop
CRAB_SCALE = 2
WALK_SECONDS = 8  # one crossing of the bar


def hex_rgb(color):
    return [int(color[i : i + 2], 16) for i in (1, 3, 5)]


def mix(start, end, amount):
    a, b = hex_rgb(start), hex_rgb(end)
    return "#" + "".join(f"{round(x + (y - x) * amount):02x}" for x, y in zip(a, b))


def pulse_at(position):
    position = min(max(position, 0), 1)
    return mix(CORAL, ROSE, position * 2) if position < 0.5 else mix(ROSE, JADE, (position - 0.5) * 2)


def noise(x, y):
    value = math.sin(x * 12.9898 + y * 78.233) * 43758.5453
    return value - math.floor(value)


def bar_cells():
    columns = BAR_W // CELL
    cells = []
    for column in range(columns):
        for row in range(ROWS):
            jitter = (noise(column, row) - 0.5) * 0.09
            color = pulse_at(column / (columns - 1) + jitter)
            cells.append(f'<rect x="{BAR_X + column * CELL}" y="{BAR_Y + row * CELL}" width="{CELL - 1}" height="{CELL - 1}" fill="{color}"/>')
    return "".join(cells)


def crab_rects():
    """The pride crab from pulse-progress (sprite after DockCrab's Clawd, via savvy-progress)."""
    rects = []

    def fill(x, y, w, h, color, cls=""):
        class_attr = f' class="{cls}"' if cls else ""
        rects.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" fill="{color}"{class_attr}/>')

    fill(7, 10, 16, 12, CLAY)
    fill(3, 14, 4, 4, CLAY)
    fill(23, 10, 4, 4, CLAY)
    fill(9, 12, 2, 2, INK)
    fill(19, 12, 2, 2, INK)
    fill(7, 22, 2, 4, CLAY, "la")
    fill(17, 22, 2, 4, CLAY, "la")
    fill(11, 22, 2, 4, CLAY, "lb")
    fill(21, 22, 2, 4, CLAY, "lb")
    fill(25, 1, 1, 13, "#8E929A")
    for index, color in enumerate(PRIDE):
        fill(26, 1 + index, 4, 1, color, "flag")
    return "".join(rects)


def steps_keyframes(name, values, unit=""):
    """Four eased steps (one per mod), a hold at full, then a fade back to the start."""
    stops = [(0, 0), (6, 0), (14, 1), (22, 1), (30, 2), (38, 2), (46, 3), (54, 3), (62, 4), (88, 4), (96, 0), (100, 0)]
    frames = " ".join(f"{percent}%{{transform:translateX({values[step]}{unit})}}" for percent, step in stops)
    return f"@keyframes {name}{{{frames}}}"


def name_keyframes(index):
    lit_at = [14, 30, 46, 62][index]
    return (
        f"@keyframes lit{index}{{0%,{lit_at - 6}%{{opacity:.38}}{lit_at}%,88%{{opacity:1}}96%,100%{{opacity:.38}}}}"
    )


def count_keyframes(index):
    windows = [(0, 14), (14, 30), (30, 46), (46, 62), (62, 96)]
    start, end = windows[index]
    if index == 0:
        return f"@keyframes n0{{0%,13%{{opacity:1}}14%,95%{{opacity:0}}96%,100%{{opacity:1}}}}"
    return f"@keyframes n{index}{{0%,{start - 1}%{{opacity:0}}{start}%,{end - 1}%{{opacity:1}}{end}%,100%{{opacity:0}}}}"


def build(variant):
    is_light = variant == "cream"
    has_crab = variant != "shimmer"
    background = "#F6F1EA" if is_light else INK
    wordmark = INK if is_light else "#F6EFE6"
    muted = "#6f675f" if is_light else "#a49c94"
    track = background

    quarter = BAR_W / 4
    fill_steps = [0, quarter, quarter * 2, quarter * 3, BAR_W]
    crab_width = 30 * CRAB_SCALE
    crab_travel = BAR_W - crab_width

    styles = [
        f"@font-face{{font-family:Fraunces;font-weight:100 900;src:url(data:font/woff2;base64,{FONT_DATA}) format('woff2')}}",
        "text{font-family:Fraunces,Georgia,serif}",
        ".mark{font-size:104px;font-weight:600;letter-spacing:-2px}",
        ".tag{font-size:26px;font-weight:400}",
        ".count{font-size:26px;font-weight:600}",
        "g,rect{transform-box:fill-box}",
    ]
    body = []

    body.append(f'<rect width="{WIDTH}" height="{HEIGHT}" rx="20" fill="{background}"/>')
    body.append(
        f'<text x="{BAR_X - 4}" y="{WORDMARK_Y}" class="mark" fill="{wordmark}">pulse<tspan fill="url(#pulse)">-</tspan>mods</text>'
    )
    body.append(f'<text x="{BAR_X}" y="{TAG_Y}" class="tag" fill="{muted}">Claude Code mods</text>')

    name_x = BAR_X + 227 + 24
    for index, name in enumerate(MODS):
        animated = f' style="animation:lit{index} {CYCLE}s infinite"' if has_crab else ""
        body.append(f'<text x="{name_x}" y="{TAG_Y}" class="tag" fill="{pulse_at(index / 3)}"{animated}>{name}</text>')
        name_x += {"progress": 107, "cache-tax": 118, "filetree": 87, "reflect": 79}[name] + 24

    body.append(f"<g>{bar_cells()}</g>")

    if has_crab:
        styles.append(steps_keyframes("fill", fill_steps, "px"))
        # The crab walks at a steady pace to the far end, turns, and walks back.
        styles.append(
            f"@keyframes walk{{from{{transform:translateX(0)}}to{{transform:translateX({crab_travel}px)}}}}"
            "@keyframes face{0%,49.99%{transform:scaleX(1)}50%,100%{transform:scaleX(-1)}}"
            f".walk{{animation:walk {WALK_SECONDS}s linear infinite alternate}}"
            f".face{{transform-origin:center;animation:face {WALK_SECONDS * 2}s linear infinite}}"
        )
        styles.extend(name_keyframes(index) for index in range(4))
        styles.extend(count_keyframes(index) for index in range(5))
        styles.append(
            "@keyframes st{0%,100%{transform:translateY(0)}50%{transform:translateY(-1px)}}"
            "@keyframes wave{0%,100%{transform:skewY(0) scaleX(1)}50%{transform:skewY(-10deg) scaleX(.85)}}"
            ".la{animation:st .5s ease-in-out infinite}.lb{animation:st .5s ease-in-out infinite .25s}"
            ".flag{transform-origin:0 50%;animation:wave .5s ease-in-out infinite}.flag:nth-child(even){animation-delay:.25s}"
        )
        # The unlit part of the bar: a background-coloured veil that slides right as each mod lands.
        body.append(
            f'<rect x="{BAR_X}" y="{BAR_Y - 1}" width="{BAR_W + 2}" height="{ROWS * CELL + 2}" fill="{track}" opacity=".8" class="veil"'
            f' style="animation:fill {CYCLE}s infinite"/>'
        )
        crab_y = BAR_Y - 26 * CRAB_SCALE - 2
        body.append(
            f'<g class="walk"><g class="face"><g transform="translate({BAR_X} {crab_y}) scale({CRAB_SCALE})">{crab_rects()}</g></g></g>'
        )
        for index in range(5):
            body.append(
                f'<text x="{BAR_X + BAR_W}" y="{TAG_Y}" text-anchor="end" class="count c{index}" fill="{wordmark}"'
                f' style="animation:n{index} {CYCLE}s infinite{";opacity:0" if index else ""}">{index}/4</text>'
            )
    else:
        styles.append("@keyframes sweep{0%{transform:translateX(-260px)}100%{transform:translateX(1300px)}}")
        styles.append("@keyframes breathe{0%,100%{opacity:.85}50%{opacity:1}}")
        body.append(
            f'<g clip-path="url(#barclip)"><rect x="0" y="{BAR_Y - 2}" width="220" height="{ROWS * CELL + 4}" fill="url(#shine)" class="shine"'
            f' style="animation:sweep 4.5s cubic-bezier(.45,0,.25,1) infinite"/></g>'
        )
        body.append(f'<text x="{BAR_X + BAR_W}" y="{TAG_Y}" text-anchor="end" class="count" fill="{wordmark}">4/4</text>')

    styles.append("@media (prefers-reduced-motion:reduce){*{animation:none!important}.veil,.c0,.shine{opacity:0!important}.c4{opacity:1!important}}")

    defs = (
        f'<linearGradient id="pulse" x1="0" x2="1"><stop offset="0" stop-color="{CORAL}"/>'
        f'<stop offset=".5" stop-color="{ROSE}"/><stop offset="1" stop-color="{JADE}"/></linearGradient>'
        '<linearGradient id="shine" x1="0" x2="1"><stop offset="0" stop-color="#fff" stop-opacity="0"/>'
        '<stop offset=".5" stop-color="#fff" stop-opacity=".55"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>'
        f'<clipPath id="barclip"><rect x="{BAR_X}" y="{BAR_Y}" width="{BAR_W}" height="{ROWS * CELL}"/></clipPath>'
    )
    if not has_crab:
        # No crab above the bar, so the bar sits closer to the text.
        start = body.index(f"<g>{bar_cells()}</g>")
        body[start:] = ['<g transform="translate(0 -28)">' + "".join(body[start:-1]) + "</g>", body[-1]]
    return (
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {WIDTH} {HEIGHT}" width="{WIDTH}" height="{HEIGHT}"'
        f' role="img" aria-label="pulse-mods: Claude Code mods progress, cache-tax, filetree and reflect">'
        f"<defs>{defs}<style>{''.join(styles)}</style></defs>{''.join(body)}</svg>"
    )


OUT_PATH.write_text(build("ink-crab"))
print(OUT_PATH, OUT_PATH.stat().st_size, "bytes")
