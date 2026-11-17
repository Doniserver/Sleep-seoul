"""꼬집 로고 파일을 만든다. 실행: python docs/logo/make_logo.py

글꼴 파일에 기대지 않도록 글자도 선으로 직접 그렸다(어느 컴퓨터에서 열어도 모양이 같다).
"""
from pathlib import Path

OUT = Path(__file__).parent
INK = "#18202F"
BLUE = "#2F7BEA"
ORANGE = "#FF8A34"
WHITE = "#FFFFFF"
NIGHT = "#101623"


def pin_house(c=BLUE, hole=WHITE):
    """1. 지도 핀 안에 집."""
    return f"""
<path d="M48 93C31 71 17 57 17 40a31 31 0 1 1 62 0c0 17-14 31-31 53z" fill="{c}"/>
<path d="M48 23.5 66 39.5h-5V56H35V39.5h-5z" fill="{hole}" stroke="{hole}" stroke-width="3" stroke-linejoin="round"/>
<rect x="43.5" y="44.5" width="9" height="13" rx="1.5" fill="{c}"/>"""


def house_pin(c=BLUE, hole=WHITE, dot=ORANGE):
    """2. 집 모양이 그대로 핀이 되는 꼴."""
    return f"""
<path d="M48 9 86 40H76v20L48 90 20 60V40H10z" fill="{c}" stroke="{c}" stroke-width="7" stroke-linejoin="round"/>
<circle cx="48" cy="50" r="11.5" fill="{hole}"/>
<circle cx="48" cy="50" r="5" fill="{dot}"/>"""


def pinch(c=BLUE, hole=WHITE, finger=ORANGE):
    """3. 두 손가락이 집을 집는 꼴."""
    return f"""
<path d="M48 50 74 70v20H22V70z" fill="{c}" stroke="{c}" stroke-width="7" stroke-linejoin="round"/>
<rect x="42" y="72" width="12" height="18" rx="2" fill="{hole}"/>
<path d="M40 31 28 10" stroke="{finger}" stroke-width="15" stroke-linecap="round"/>
<path d="M56 31 68 10" stroke="{finger}" stroke-width="15" stroke-linecap="round"/>"""


def bubble(c=ORANGE, hole=WHITE):
    """4. 말풍선 안에 집 (꼬집어 말해 준다)."""
    return f"""
<path d="M30 12h36a20 20 0 0 1 20 20v22a20 20 0 0 1-20 20H44L24 90V72.5A20 20 0 0 1 10 54V32a20 20 0 0 1 20-20z" fill="{c}"/>
<path d="M48 26 64 40h-4.5V58h-23V40H32z" fill="{hole}" stroke="{hole}" stroke-width="3" stroke-linejoin="round"/>"""


def word(c=INK, accent=ORANGE, w=8.5):
    """'꼬집' 글자. 128x82 상자 안."""
    s = f'fill="none" stroke="{c}" stroke-width="{w}" stroke-linecap="round" stroke-linejoin="round"'
    a = f'fill="none" stroke="{accent}" stroke-width="{w}" stroke-linecap="round" stroke-linejoin="round"'
    return f"""
<path d="M6 10h19v27M35 10h19v27" {s}/>
<path d="M30 53v18M5 74h50" {s}/>
<path d="M71 10h30M86 11 72 34M86 11l14 23" {a}/>
<path d="M119 6v28" {s}/>
<path d="M80 46v28h39V46M80 59h39" {s}/>"""


def svg(body, w, h, bg=None):
    r = f'<rect width="{w}" height="{h}" fill="{bg}"/>' if bg else ""
    return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" width="{w}" height="{h}">{r}{body}\n</svg>\n'


def app_icon(mark, bg=BLUE):
    return f'<rect width="96" height="96" rx="22" fill="{bg}"/><g transform="translate(14.4 14.4) scale(0.7)">{mark}</g>'


def lockup(mark, ink=INK):
    return f'<g>{mark}</g><g transform="translate(112 7)">{word(ink)}</g>'


# 이름: (밝은 바탕용, 어두운 바탕용, 앱 아이콘용 그림, 앱 아이콘 바탕)
MARKS = {
    "1-핀집": (pin_house(), pin_house(BLUE, NIGHT), pin_house(WHITE, BLUE), BLUE),
    "2-집핀": (house_pin(), house_pin(BLUE, NIGHT), house_pin(WHITE, BLUE), BLUE),
    "3-꼬집기": (pinch(), pinch(BLUE, NIGHT), pinch(WHITE, BLUE), BLUE),
    "4-말풍선": (bubble(), bubble(ORANGE, NIGHT), bubble(WHITE, ORANGE), ORANGE),
}


def main():
    cells = []
    for i, (name, (light, dark, icon, icon_bg)) in enumerate(MARKS.items()):
        (OUT / f"꼬집-{name}-아이콘.svg").write_text(svg(light, 96, 96), encoding="utf-8")
        (OUT / f"꼬집-{name}-가로.svg").write_text(svg(lockup(light), 248, 96), encoding="utf-8")
        (OUT / f"꼬집-{name}-가로-어두운바탕.svg").write_text(
            svg(lockup(dark, WHITE), 248, 96), encoding="utf-8")
        (OUT / f"꼬집-{name}-앱아이콘.svg").write_text(svg(app_icon(icon, icon_bg), 96, 96), encoding="utf-8")

        y = 40 + i * 230
        cells.append(f'<g transform="translate(40 {y})">{light}</g>')
        cells.append(f'<g transform="translate(190 {y})">{lockup(light)}</g>')
        cells.append(f'<rect x="490" y="{y - 14}" width="310" height="124" rx="14" fill="{NIGHT}"/>')
        cells.append(f'<g transform="translate(520 {y})">{lockup(dark, WHITE)}</g>')
        cells.append(f'<g transform="translate(830 {y + 16}) scale(0.667)">{app_icon(icon, icon_bg)}</g>')
        cells.append(f'<g transform="translate(912 {y + 40}) scale(0.1667)">{light}</g>')
    (OUT / "꼬집-글자.svg").write_text(svg(word(), 128, 82), encoding="utf-8")
    (OUT / "시안표.svg").write_text(svg("".join(cells), 960, 960, WHITE), encoding="utf-8")


if __name__ == "__main__":
    main()
