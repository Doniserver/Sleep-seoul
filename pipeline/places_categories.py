"""상가(상권)정보 업종 → 화면용 시설 분류. 업종명은 API smallUpjongList 응답으로 확인함(2026-11)."""
from __future__ import annotations

# 화면에 보이는 순서. (키, 이름, 기본으로 켤지)
CATEGORIES = [
    ("food", "식당", True),
    ("cafe", "카페·디저트", True),
    ("bar", "술집", True),
    ("hospital", "병원", True),
    ("pharmacy", "약국", True),
    ("mart", "편의점·마트", True),
    ("gym", "운동", True),
    ("academy", "학원", True),
    ("leisure", "여가", True),
    ("life", "생활", False),
    ("office", "사무실", False),
    ("etc", "기타", False),
]
CAT_INDEX = {k: i for i, (k, _, _) in enumerate(CATEGORIES)}

CAFE = {"카페", "빵/도넛", "아이스크림/빙수", "떡/한과"}
BAR = {"무도 유흥 주점", "생맥주 전문", "요리 주점", "일반 유흥 주점"}
MART = {"편의점", "슈퍼마켓"}
GYM = {"헬스장", "요가/필라테스 학원", "종합 스포츠시설", "수영장", "골프 연습장", "스쿼시/라켓볼장",
       "테니스장", "탁구장", "기타 스포츠시설 운영업"}
LEISURE = {"노래방", "PC방", "당구장", "볼링장", "독서실/스터디 카페", "목욕탕/사우나", "만화방", "비디오방",
           "전자 게임장", "기타 오락장", "기타 오락관련 서비스업", "바둑/장기/체스 경기 운영업"}
LIFE = {"미용실", "네일숍", "피부 관리실", "세탁소", "셀프 빨래방", "마사지/안마", "체형/비만 관리",
        "꽃집", "애완동물/애완용품 소매업", "안경렌즈 소매업"}


def categorize(lcls: str | None, scls: str | None) -> str:
    """상권업종 대분류명·소분류명 → 화면 분류 키."""
    lcls = (lcls or "").strip()
    scls = (scls or "").strip()
    if lcls == "음식":
        if scls in CAFE:
            return "cafe"
        if scls in BAR:
            return "bar"
        return "food"
    if lcls == "보건의료":
        return "hospital"
    if scls == "약국":
        return "pharmacy"
    if scls in MART:
        return "mart"
    if scls in GYM:
        return "gym"
    if lcls == "교육":
        return "academy"
    if scls in LEISURE:
        return "leisure"
    if scls in LIFE:
        return "life"
    if lcls == "과학·기술":
        return "office"
    return "etc"
