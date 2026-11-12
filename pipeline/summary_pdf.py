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
    nm = json.loads((C.WEB_DATA / "noisemap" / "noisemap.json").read_text(encoding="utf-8"))
    return {"year": y["year"], "nights": y["nights"], "sensors": y["sensors_used"], "dongs": y["dongs_with_data"],
            "median": y["seoul_median"], "n_fit": nm["n_sensors"],
            "mae_n": nm["accuracy"]["mae"], "in3_n": round(nm["accuracy"]["within3"] * 100),
            "mae_d": (nm.get("day") or {}).get("accuracy", {}).get("mae"),
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
        P(f"서울 길가 도시센서(S-DoT)가 잰 소음으로 동네와 자리별 <b>바깥 소음</b>을 비교하는 지도 사이트입니다. "
          f"이사·자취 후보지를 추리고, 뚜렷하게 시끄러운 곳을 피하고, 집 보러 가기 전에 확인할 것을 알려 주는 용도입니다. "
          f"기준 자료: <b>{f['year']}년</b> 1년(밤 {f['nights']}일) · 이 문서 갱신일 {dt.date.today().isoformat()}", small),

        P("1. 어떤 자료로 만들었나", h2),
        table([
            ["제공처", "자료", "사이트에서의 쓰임"],
            ["서울특별시<br/>(서울 열린데이터광장)", f"S-DoT 환경정보: 센서별 1시간 단위 소음·조도 ({f['year']}년 1년치 파일 + 최근 한 달 API), 센서 설치 위치정보",
             f"모든 소음 숫자의 바탕. 동네 값은 센서 {f['sensors']}개로 {f['dongs']}개 동을 계산"],
            ["국토교통부<br/>(브이월드)", "도로중심선 13만 개(차로 수·폭), 철도시설 1,043곳, 건물 128만 동 / 배경지도·항공사진·3D 지도·장소 검색",
             "앞의 셋은 10m 상세 지도 계산과 주의 표시, 뒤의 넷은 화면 표시와 검색"],
            ["소상공인시장진흥공단<br/>(공공데이터포털)", "상가(상권)정보: 음식점·술집·노래방·숙박 17만 곳", "상세 지도 계산과 주의 표시 (가게 위치를 화면에 그리지는 않음)"],
            ["공개 저장소<br/>(vuski/admdongkor)", "행정동 경계 (2026-10-01 판)", "동네 경계선, 센서를 동에 배정"],
            ["기준값", "WHO 환경소음 가이드라인 40·45·55dB", "차트와 리포트의 기준선"],
        ], [W * 0.19, W * 0.46, W * 0.35]),
        P("준비만 된 것: 국토교통부 공동주택 기본정보(층간소음 추정용, 목록 API 권한 문제로 화면에는 '준비 중'). 자료별 파일 위치와 받는 방법은 <b>data/README.md</b>.", small),

        P("2. 어떻게 계산했나", h2),
        *bullets([
            f"<b>동네 값</b>: 밤(22~06시)·낮(06~22시)의 시간별 값을 에너지 평균으로 합친 뒤, 그 동 주거지역 센서들의 가운데 값(중앙값)을 씁니다. 센서가 없는 동은 비워 둡니다. {f['year']}년 서울 동네 밤 중앙값 {f['median']}dB.",
            "<b>센서 기종 보정</b>: 구형 기종(V02)이 다른 기종보다 약 8.5dB 낮게 읽어 그만큼 더합니다. 보정 뒤 수준이 서울시 공식 통계(주거지 밤 약 52dB)와 맞습니다.",
            f"<b>10m 상세 지도(추정)</b>: 서울을 10m 칸으로 나누고, 칸마다 주변 도로·철도·업소 밀집·건물 가림을 숫자로 만든 뒤, 센서 {f['n_fit']}곳에서 그 조건과 실제 소음의 관계를 배워 모든 칸에 적용했습니다.",
            f"<b>정확도</b>: 센서를 가리고 맞혀 보는 검증에서 평균 오차 밤 {f['mae_n']}dB" + (f", 낮 {f['mae_d']}dB" if f["mae_d"] else "") + f" (밤 기준 3dB 안 {f['in3_n']}%). 큰길가와 골목 안쪽의 차이는 믿을 만하고, 비슷한 골목끼리의 1~2dB 차이는 믿기 어렵습니다.",
            f"<b>보조 지표</b>: 수면 점수(밤 {f['t']['score_best']}dB 이하 100점 ~ {f['t']['score_worst']}dB 이상 0점), 조용한 밤 비율({f['t']['quiet_night']}dB 미만), 피크 횟수({f['t']['peak']}dB 초과), 밤 밝기(lux), 주말 효과, 소음 패턴 유형(요일×시간 모양을 자동 분류).",
        ]),

        P("3. 화면에서 어떻게 보여 주나", h2),
        table([
            ["지도 색", f"가운데(중간)는 회색, <font color='{BLUE}'>조용한 쪽은 파랑</font>, <font color='{ORANGE}'>시끄러운 쪽은 주황→노랑</font>. 배경지도와 항공사진은 회색조로 낮춰 소음만 색으로 읽힙니다. 낮은 서울 전체가 4~5dB 높아 색 기준을 그만큼 옮기고 범례에 표시합니다."],
            ["두 겹의 지도", "① 동네 색칠 = 센서 측정값(동 단위) ② 상세 지도 = 10m 칸 추정값. 밤·낮 버튼으로 바꿔 봅니다. 보기 방식은 배경지도 / 실사 2D / 실사 3D."],
            ["자리 카드", "지도를 누르거나 장소를 검색하면 그 자리의 추정 소음, 가까운 센서의 측정값, 주의 표시(큰 도로·철도·음식점·술집·노래방 밀집), 큰길에서 그 자리까지 소음이 줄어드는 단면도가 나옵니다."],
            ["동네 리포트", "밤 소음과 WHO 기준 대비 차이, 수면 점수, 요일×시간 히트맵, 조용한 밤 달력, 소음 패턴 유형. '두 동네 비교' 화면에서 후보 두 곳을 나란히 봅니다."],
        ], [W * 0.16, W * 0.84], head=False),

        P("4. 꼭 알아야 할 한계", h2),
        *bullets([
            "길가 센서로 잰 <b>동네 바깥 소음</b>입니다. 집 안 소음이 아니며, 간이측정기 기반의 <b>비교용 지표</b>입니다(법정 측정 아님).",
            "상세 지도는 측정이 아닌 <b>추정</b>입니다. 공사장·학교·특정 가게처럼 자료에 없는 소음, 층수와 창문 방향은 반영하지 못합니다. 건물 뒤쪽이 얼마나 조용한지는 실측으로 확인하지 못했습니다.",
            "센서가 1~3개뿐인 동은 센서가 달린 자리(큰길가인지 골목인지)에 따라 동네 값이 크게 달라집니다. 층간소음 등급은 건축 연식 기준 <b>추정</b>이며 아직 준비 중입니다.",
        ]),
        Spacer(1, 4),
        P("만드는 방법: 자료 수집 pipeline/fetch_*.py → 동네 집계 pipeline/yearly.py → 상세 지도 pipeline/noisemap.py → 화면 web/ (Vite·TypeScript·MapLibre·D3). "
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
