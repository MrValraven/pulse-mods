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
CRAB_SCALE = 2
WALK = 8  # seconds for one crossing of the bar
HOLD = 0.8  # seconds the crab rests and turns at each end
CYCLE = 2 * (WALK + HOLD)  # rest, walk right, rest, walk back


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


def percent(seconds):
    return min(max(seconds / CYCLE * 100, 0), 100)


def time_at(progress, outbound):
    """When the crab, and the fill edge with it, is `progress` of the way along the bar."""
    return HOLD + progress * WALK if outbound else 2 * HOLD + WALK + (1 - progress) * WALK


def travel_keyframes(name, distance):
    """Rest at the start, cross at a steady pace, rest at the end, cross back."""
    stops = [(0, 0), (HOLD, 0), (HOLD + WALK, distance), (2 * HOLD + WALK, distance), (CYCLE, 0)]
    frames = "".join(f"{percent(seconds):.3f}%{{transform:translateX({offset:.1f}px)}}" for seconds, offset in stops)
    return f"@keyframes {name}{{{frames}}}"


def opacity_keyframes(name, intervals, low, high, fade):
    """Opacity `high` inside each (start, end) interval in seconds and `low` outside it, switching over `fade` percent."""
    points = []
    for start, end in intervals:
        start_percent, end_percent = percent(start), percent(end)
        points += [(0, high)] if start_percent == 0 else [(start_percent, low), (start_percent + fade, high)]
        points += [(100, high)] if end_percent == 100 else [(end_percent, high), (end_percent + fade, low)]
    if points[0][0] != 0:
        points.insert(0, (0, low))
    if points[-1][0] != 100:
        points.append((100, low))
    frames = "".join(f"{value_at:.3f}%{{opacity:{value}}}" for value_at, value in points)
    return f"@keyframes {name}{{{frames}}}"


def count_intervals(count):
    """When the count reads `count`/4: the fill has passed count quarters and not the next one."""
    if count == 4:
        return [(time_at(1, True), time_at(1, False))]
    lower, upper = count / 4, (count + 1) / 4
    if count == 0:
        return [(0, time_at(upper, True)), (time_at(upper, False), CYCLE)]
    return [(time_at(lower, True), time_at(upper, True)), (time_at(upper, False), time_at(lower, False))]


def build(variant):
    is_light = variant == "cream"
    has_crab = variant != "shimmer"
    background = "#F6F1EA" if is_light else INK
    wordmark = INK if is_light else "#F6EFE6"
    muted = "#6f675f" if is_light else "#a49c94"
    track = background

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
        animated = f' style="animation:lit{index} {CYCLE}s linear infinite"' if has_crab else ""
        body.append(f'<text x="{name_x}" y="{TAG_Y}" class="tag" fill="{pulse_at(index / 3)}"{animated}>{name}</text>')
        name_x += {"progress": 107, "cache-tax": 118, "filetree": 87, "reflect": 79}[name] + 24

    body.append(f"<g>{bar_cells()}</g>")

    if has_crab:
        # The crab walks at a steady pace to the far end, turns, and walks back. The fill edge stays under it,
        # so the bar fills behind the crab on the way out and empties on the way back.
        turn_right, turn_left = percent(HOLD / 2), percent(HOLD + WALK + HOLD / 2)
        styles.append(travel_keyframes("walk", crab_travel))
        styles.append(travel_keyframes("fill", BAR_W))
        styles.append(
            f"@keyframes face{{0%,{turn_right - 0.01:.3f}%{{transform:scaleX(-1)}}{turn_right:.3f}%,{turn_left - 0.01:.3f}%"
            f"{{transform:scaleX(1)}}{turn_left:.3f}%,100%{{transform:scaleX(-1)}}}}"
            f".walk{{animation:walk {CYCLE}s linear infinite}}"
            f".face{{transform-origin:center;animation:face {CYCLE}s linear infinite}}"
        )
        # A mod name lights up once the fill passes its quarter, and dims when the fill drops back below it.
        styles.extend(
            opacity_keyframes(f"lit{index}", [(time_at((index + 1) / 4, True), time_at((index + 1) / 4, False))], 0.38, 1, 1)
            for index in range(4)
        )
        styles.extend(opacity_keyframes(f"n{count}", count_intervals(count), 0, 1, 0.01) for count in range(5))
        styles.append(
            "@keyframes st{0%,100%{transform:translateY(0)}50%{transform:translateY(-1px)}}"
            "@keyframes wave{0%,100%{transform:skewY(0) scaleX(1)}50%{transform:skewY(-10deg) scaleX(.85)}}"
            ".la{animation:st .5s ease-in-out infinite}.lb{animation:st .5s ease-in-out infinite .25s}"
            ".flag{transform-origin:0 50%;animation:wave .5s ease-in-out infinite}.flag:nth-child(even){animation-delay:.25s}"
        )
        # The unlit part of the bar: a background-coloured veil that slides with the crab.
        body.append(
            f'<rect x="{BAR_X}" y="{BAR_Y - 1}" width="{BAR_W + 2}" height="{ROWS * CELL + 2}" fill="{track}" opacity=".8" class="veil"'
            f' style="animation:fill {CYCLE}s linear infinite"/>'
        )
        crab_y = BAR_Y - 26 * CRAB_SCALE - 2
        body.append(
            f'<g class="walk"><g class="face"><g transform="translate({BAR_X} {crab_y}) scale({CRAB_SCALE})">{crab_rects()}</g></g></g>'
        )
        for index in range(5):
            body.append(
                f'<text x="{BAR_X + BAR_W}" y="{TAG_Y}" text-anchor="end" class="count c{index}" fill="{wordmark}"'
                f' style="animation:n{index} {CYCLE}s linear infinite{";opacity:0" if index else ""}">{index}/4</text>'
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
