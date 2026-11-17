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
    cf = C.WEB_DATA / "years" / f"{y['year']}_cells.json"
    ce = json.loads(cf.read_text(encoding="utf-8")) if cf.exists() else {"cells": [], "n_sensors": 0, "cuts": [0, 0], "hex_m": 0}
    return {"year": y["year"], "nights": y["nights"], "sensors": y["sensors_used"], "dongs": y["dongs_with_data"],
            "median": y["seoul_median"], "cells": len(ce["cells"]), "cell_sensors": ce["n_sensors"], "cuts": ce["cuts"], "hex": int(ce["hex_m"]),
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
        P(f"서울 길가 도시센서(S-DoT)가 잰 <b>집 밖 소음</b>을 500m 칸과 0~23시 시각별로 보여 주는 지도 사이트입니다. "
          f"이사·자취 후보지를 추리고, 뚜렷하게 시끄러운 곳을 피하고, 집 보러 가기 전에 확인할 것을 알려 주는 용도입니다. "
          f"기준 자료: <b>{f['year']}년</b> 1년(밤 {f['nights']}일) · 이 문서 갱신일 {dt.date.today().isoformat()}", small),

        P("<b>알림 (2026-11-18)</b>: 표현 방식을 다시 정하는 동안 지도의 소음 색칠을 잠시 내려 두었습니다. 지금 화면에는 배경지도와 장소 찾기만 나옵니다. 아래 2~3번은 준비해 둔 방식입니다.", small),
        P("1. 어떤 자료로 만들었나", h2),
        table([
            ["제공처", "자료", "사이트에서의 쓰임"],
            ["서울특별시<br/>(서울 열린데이터광장)", f"S-DoT 환경정보: 센서별 1시간 단위 소음·조도 ({f['year']}년 1년치 파일 + 최근 한 달 API), 센서 설치 위치정보",
             f"모든 소음 숫자의 바탕. 센서 {f['cell_sensors']}개가 들어 있는 {f['cells']}개 칸을 칠함"],
            ["국토교통부<br/>(브이월드)", "배경지도, 항공사진, 3D 지도, 장소 검색", "화면의 지도 바탕(배경지도·실사 2D·실사 3D)과 검색창"],
            ["공개 저장소<br/>(vuski/admdongkor)", "행정동 경계 (2026-10-01 판)", "위치를 알아보는 옅은 경계선, 동네 이름 검색"],
        ], [W * 0.19, W * 0.46, W * 0.35]),
        P("화면에 쓰지 않는 것: 브이월드 도로·철도·건물과 상가정보(조사용), 서울시 지점별 환경소음 측정(센서 검증용). 상업적 이용 조건과 자료별 파일 위치와 받는 방법은 <b>data/README.md</b>.", small),

        P("2. 어떻게 계산했나", h2),
        *bullets([
            f"<b>칸</b>: 서울을 폭 {f['hex']}m 육각형 칸으로 나눕니다(행정동 평균의 6분의 1쯤). 센서가 들어 있는 칸만 값을 갖습니다.",
            f"<b>칸 값</b>: 센서마다 {f['year']}년 한 해의 시각별(0~23시) 평균을 에너지 평균으로 구하고, 칸 안 센서들의 가운데 값(중앙값)을 씁니다.",
            f"<b>점수 세 단계</b>: {f['cuts'][0]:g}dB 미만 = 조용 100점, {f['cuts'][1]:g}dB 미만 = 보통 70점, 그 이상 = 시끄러움 40점. 하루 내내 같은 기준을 써서 시간에 따른 변화가 그대로 보입니다(잠정값, 팀 확정 필요).",
            "<b>센서 기종 보정</b>: 구형 기종(V02)이 다른 기종보다 약 8.5dB 낮게 읽어 그만큼 더합니다.",
            "<b>센서가 없는 칸</b>: 색을 칠하지 않습니다. 가까운 센서끼리도 값이 크게 달라, 주변 값으로 메우면 틀리기 때문입니다.",
        ]),

        P("3. 화면에서 어떻게 보여 주나", h2),
        table([
            ["지도 색", f"<font color='{BLUE}'>파랑 = 조용</font>, 회색 = 보통, <font color='{ORANGE}'>주황 = 시끄러움</font>, 색 없음 = 측정 없음. 지도에는 색만 두고 설명은 왼쪽 아래 한 상자에 적습니다. 배경지도와 항공사진은 회색조로 낮춥니다."],
            ["시각 막대", "0시부터 23시까지 막대를 끌면 그 시각의 색으로 바뀝니다. '하루 재생'을 누르면 자동으로 넘어갑니다. 보기 방식은 배경지도 / 실사 2D / 실사 3D."],
            ["칸을 누르면", "그 시각의 등급과 점수, 쉬운 말 한 줄, 0~23시 하루 띠(누르면 그 시각으로 이동), 조용한 시간과 시끄러운 시간의 수가 나옵니다. dB 숫자는 '숫자로 보기'를 눌러야 보입니다. 동네나 장소를 검색하면 그 자리로 옮깁니다."],
        ], [W * 0.16, W * 0.84], head=False),

        P("4. 꼭 알아야 할 한계", h2),
        *bullets([
            "길가 센서로 잰 <b>집 밖 소음</b>입니다. 집 안 소음이 아니며, 간이측정기 기반의 <b>비교용 지표</b>입니다(법정 측정 아님).",
            "칸의 값은 <b>센서가 달린 자리의 값</b>입니다. 칸의 대부분은 센서가 1개뿐이고, 같은 칸 안에서도 큰길가와 골목 안쪽은 다를 수 있습니다.",
            "서울시 공식 측정(2025년 74지점)과 견줬을 때 가까운 센서의 등급이 절반만 일치했습니다. <b>같은 자리의 시간에 따른 변화</b>는 믿을 만하지만, <b>자리끼리의 비교는 참고용</b>입니다.",
        ]),
        Spacer(1, 4),
        P("만드는 방법: 자료 수집 pipeline/fetch_*.py → 연도 정리 pipeline/yearly.py → 칸 집계 pipeline/cells.py → 화면 web/ (Vite·TypeScript·MapLibre·D3). "
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
