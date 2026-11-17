"""사이트 설명서 한 장(PDF)을 만든다.

    python -m pipeline.summary_pdf          # → docs/사이트-설명서.pdf (항상 같은 파일을 덮어씀)

- 사이트가 바뀌면(자료·계산·화면) 아래 글을 고치고 다시 실행한다. 옛 PDF는 남기지 않는다.
- 숫자(연도, 센서 수, 정확도)는 사이트 결과 파일에서 읽어 오므로 손으로 고치지 않는다.
- 반드시 1쪽이어야 한다. 넘치면 오류를 내므로 글을 줄인다.
- 준비: pip install reportlab (macOS 기본 한글 글꼴 AppleGothic 사용)
"""
from __future__ import annotations

import datetime as dt
import json
from pathlib import Path

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle
from reportlab.lib.units import mm
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

from . import config as C

OUT = C.ROOT / "docs" / "사이트-설명서.pdf"
FONTS = ["/System/Library/Fonts/Supplemental/AppleGothic.ttf", "/Library/Fonts/Arial Unicode.ttf"]
INK, SUB, LINE, ACCENT, BLUE, ORANGE = "#141a26", "#566074", "#d5dae3", "#b36b00", "#2c6bc7", "#ea7d22"


def facts() -> dict:
    """사이트 결과 파일에서 읽은 숫자."""
    y = json.loads((C.WEB_DATA / "years" / "index.json").read_text(encoding="utf-8"))[-1]
    h = json.loads((C.WEB_DATA / "heat" / "heat.json").read_text(encoding="utf-8"))
    maes = [f["mae"] for f in h["frames"].values()]
    return {"year": h["year"], "nights": y["nights"], "sensors": h["n_sensors"], "mae": round(sum(maes) / len(maes), 1),
            "ncut": h["frames"]["night"]["cuts"], "dcut": h["frames"]["day"]["cuts"], "share": [round(x * 100) for x in h["frames"]["night"]["share"]],
            "sigma": int(h["sigma_m"]), "cell": int(h["cell_m"]),
            "t": json.loads((C.WEB_DATA / "meta.json").read_text(encoding="utf-8"))["thresholds"]}


def build(out: Path = OUT) -> Path:
    font = next(f for f in FONTS if Path(f).exists())
    pdfmetrics.registerFont(TTFont("KR", font))
    f = facts()
    base = ParagraphStyle("b", fontName="KR", fontSize=9, leading=12.8, textColor=colors.HexColor(INK))
    small = ParagraphStyle("s", parent=base, fontSize=7.9, leading=10.8, textColor=colors.HexColor(SUB))
    h1 = ParagraphStyle("h1", parent=base, fontSize=19, leading=23)
    h2 = ParagraphStyle("h2", parent=base, fontSize=11.5, leading=14, textColor=colors.HexColor(ACCENT), spaceBefore=7, spaceAfter=3)
    cell = ParagraphStyle("c", parent=base, fontSize=8.4, leading=11.4)
    P = lambda t, s=base: Paragraph(t, s)
    bullets = lambda items: [P(f"<font color='{ACCENT}'>•</font>&nbsp; {t}") for t in items]

    def table(rows, widths, head=True):
        t = Table([[P(c, cell) for c in r] for r in rows], colWidths=widths)
        st = [("VALIGN", (0, 0), (-1, -1), "TOP"), ("LINEBELOW", (0, 0), (-1, -1), 0.4, colors.HexColor(LINE)),
              ("TOPPADDING", (0, 0), (-1, -1), 2.2), ("BOTTOMPADDING", (0, 0), (-1, -1), 2.6),
              ("LEFTPADDING", (0, 0), (-1, -1), 3), ("RIGHTPADDING", (0, 0), (-1, -1), 3)]
        if head:
            st.append(("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#f1f3f7")))
        t.setStyle(TableStyle(st))
        return t

    W = A4[0] - 28 * mm
    story = [
        P("잠 잘 오는 동네 <font size=10 color='%s'>사이트 설명서 (한 장)</font>" % SUB, h1),
        P(f"서울의 <b>집 밖 소음</b>을 조용·보통·시끄러움 세 단계로 보여 주는 지도 사이트입니다. 집을 알아보는 사람이 어디를 먼저 볼지 고르는 데 씁니다. "
          f"기준 자료: <b>{f['year']}년</b> 1년 · 이 문서 갱신일 {dt.date.today().isoformat()}", small),

        P("1. 어떤 자료로 만들었나", h2),
        table([
            ["제공처", "자료", "사이트에서의 쓰임", "상업 이용"],
            ["서울특별시<br/>(서울 열린데이터광장)", f"S-DoT 환경정보: 센서별 1시간 단위 소음 ({f['year']}년), 센서 위치", f"소음 값의 바탕. 센서 {f['sensors']}곳", "가능<br/>(출처 표시)"],
            ["국토지리정보원<br/>(브이월드 공간정보 다운로드)", "연속수치지형도 도로중심선 (차로 수, 사람이 직접 받는 파일)", "큰길과의 거리 계산", "가능<br/>(출처 표시)"],
            ["소상공인시장진흥공단<br/>(공공데이터포털)", "상가(상권)정보: 음식점·술집·노래방·숙박 위치", "가게 밀집 정도", "가능"],
            ["통계청 (공개 저장소)<br/>국토교통부 (브이월드)", "행정동 경계 / 배경지도·항공사진·3D·장소 찾기", "동네 경계와 이름 / 지도 바탕", "가능"],
        ], [W * 0.24, W * 0.38, W * 0.25, W * 0.13]),
        P("쓰지 않는 것: 철도·건물 자료(빼도 정확도가 같아 뺌), API로 받아 저장한 브이월드 자료(약관상 상업 이용 불가). 서울시 지점별 환경소음 측정은 검증에만 씀. 자세한 조건은 <b>data/README.md</b>.", small),

        P("2. 어떻게 계산했나", h2),
        *bullets([
            "<b>추정</b>: 센서 자리마다 주변 도로(2·4·6차로 이상)와 가게 수를 세고, 센서가 잰 값과의 관계를 찾아 서울 전체 10m 칸에 적용합니다.",
            f"<b>묶기</b>: 주변 약 {f['sigma']}m를 부드럽게 묶어 {f['cell']}m 간격 지도로 만듭니다. 밤(22~06시) 평균, 낮(06~22시) 평균, 0~23시 시각별로 따로 계산합니다.",
            f"<b>세 단계</b>: 밤 평균은 {f['ncut'][0]:g}dB 미만 조용(100점), {f['ncut'][1]:g}dB 미만 보통(70점), 그 이상 시끄러움(40점). 서울의 {f['share'][0]}% / {f['share'][1]}% / {f['share'][2]}%. 낮은 기준을 {f['dcut'][0] - f['ncut'][0]:g}dB 올립니다(잠정값).",
            "<b>시각별 기준</b>: 한밤(23~04시)은 밤 기준, 한낮(08~19시)은 낮 기준, 아침·저녁은 그 사이 값. 기준이 갑자기 바뀌지 않게 한 것입니다.",
            "<b>동네별</b>: 동네 자리들의 평균 소음을 같은 기준으로 나눠 조용·보통·시끄러움을 매깁니다(도로가 300m 안에 없는 산·강은 제외).",
        ]),

        P("3. 화면에서 어떻게 보여 주나", h2),
        table([
            ["히트맵", f"조용한 곳은 칠하지 않고, <font color='{ORANGE}'>보통은 옅은 주황</font>, <font color='#c23b2e'>시끄러움은 빨강</font>. 색이 진할수록 시끄럽습니다. 지도를 누르면 그 자리의 단계·점수와 하루 24시간 띠가 나옵니다."],
            ["동네별", "같은 자료를 행정동 단위로 세 색(조용·보통·시끄러움)으로 칠합니다. 동네를 누르면 단계·점수, 동네 안의 비율, 하루 띠가 나옵니다."],
            ["시간", "밤 / 낮 단추(평균)와 0~23시 막대, '하루 재생'. 지도 바탕은 배경지도 / 실사 2D / 실사 3D."],
        ], [W * 0.14, W * 0.86], head=False),

        P("4. 꼭 알아야 할 한계", h2),
        *bullets([
            f"<b>집 밖 소음의 추정값</b>입니다. 집 안 소음이 아니며, 센서를 가리고 맞혀 보는 시험의 평균 오차는 약 {f['mae']}dB입니다.",
            "센서는 간이측정기입니다. 서울시 공식 측정과 견주면 <b>큰길가 소음을 실제보다 낮게</b> 재는 경향이 있습니다.",
            "공사장·학교·철도·비행기처럼 계산에 넣지 않은 소리는 나타나지 않습니다. 같은 dB라도 시각에 따라 단계가 다를 수 있습니다.",
        ]),
        Spacer(1, 4),
        P("만드는 방법: 자료 수집 pipeline/fetch_*.py·roads_shp.py → 연도 정리 pipeline/yearly.py → 히트맵 pipeline/heatmap.py → 화면 web/ (Vite·TypeScript·MapLibre·D3). "
          "산식과 검증 내역은 docs/methodology.md, docs/data-check.md. 이 문서는 python -m pipeline.summary_pdf 로 다시 만듭니다.", small),
    ]
    doc = SimpleDocTemplate(str(out), pagesize=A4, leftMargin=14 * mm, rightMargin=14 * mm, topMargin=12 * mm, bottomMargin=10 * mm,
                            title="잠 잘 오는 동네 사이트 설명서", author="잠 잘 오는 동네 팀")
    doc.build(story)
    if doc.page != 1:
        out.unlink()
        raise SystemExit(f"설명서가 {doc.page}쪽이 됐습니다. 1쪽에 들어가도록 글을 줄이세요.")
    return out


if __name__ == "__main__":
    print(f"[summary] 저장: {build().relative_to(C.ROOT)}")
