"""파이프라인 공통 설정. 숫자 기준은 docs/methodology.md와 함께 바꿀 것."""
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
RAW = ROOT / "data" / "raw"
HOURLY = ROOT / "data" / "hourly"          # 정제된 시간별 소음·조도 (일 단위 parquet, 커밋함)
DERIVED = ROOT / "data" / "derived"        # 중간 산출물 (커밋 안 함)
WEB_DATA = ROOT / "web" / "public" / "data"

BOUNDARY_FILE = RAW / "boundary" / "HangJeongDong_ver20261001.geojson"
BOUNDARY_VERSION = "2026-10-01"
LOCATION_GLOB = "*설치 위치정보*.xlsx"
CSV_GLOB = "S-DoT_NATURE_*.csv"

# Seoul Open API (명세서: Open API 명세서(20250716).xlsx)
SDOT_SERVICE = "IotVdata017"
SDOT_API = "http://openapi.seoul.go.kr:8088/{key}/json/" + SDOT_SERVICE + "/{start}/{end}/{gu}/{date}"
SDOT_PAGE = 1000  # ERROR-336: 한 번에 최대 1000건

GU_EN = {
    "종로구": "Jongno-gu", "중구": "Jung-gu", "용산구": "Yongsan-gu", "성동구": "Seongdong-gu",
    "광진구": "Gwangjin-gu", "동대문구": "Dongdaemun-gu", "중랑구": "Jungnang-gu", "성북구": "Seongbuk-gu",
    "강북구": "Gangbuk-gu", "도봉구": "Dobong-gu", "노원구": "Nowon-gu", "은평구": "Eunpyeong-gu",
    "서대문구": "Seodaemun-gu", "마포구": "Mapo-gu", "양천구": "Yangcheon-gu", "강서구": "Gangseo-gu",
    "구로구": "Guro-gu", "금천구": "Geumcheon-gu", "영등포구": "Yeongdeungpo-gu", "동작구": "Dongjak-gu",
    "관악구": "Gwanak-gu", "서초구": "Seocho-gu", "강남구": "Gangnam-gu", "송파구": "Songpa-gu",
    "강동구": "Gangdong-gu",
}

# ── 지표 기준 ──────────────────────────────────────────────
# 측정시간 표기(예: 07:07)는 그 앞 1시간 구간의 끝 → 구간 시작 시각 = 표기 - 1시간
NIGHT_START_HOURS = [22, 23, 0, 1, 2, 3, 4, 5]   # 22:00~06:00 (구간 시작 시각 기준)
MIN_HOURS_PER_NIGHT = 6           # 하룻밤 8시간 중 6시간 이상 있어야 유효한 밤
MAX_NIGHT_MISSING = 0.30          # 기간 내 밤 시간 결측률이 이보다 크면 센서 제외
NOISE_FLOOR_DB = 35               # 센서 하한 (이 값은 "35dB 이하"를 뜻함)
PEAK_DB = 70                      # 밤 시간대 시간별 최대값 > 70dB = 피크 1회
QUIET_NIGHT_DB = 45               # 조용한 밤 기준
LUX_REF = 10                      # 주거지역 침입광 참고선
LUX_BROKEN = 2000                 # 밤 조도 중앙값이 이보다 크면 조도 센서 이상으로 보고 제외
WHO_LINES = {"who_target": 40, "who_road": 45, "who_interim": 55}

# 이상치(공사·축제 등): 센서별 하룻밤 L_night가 그 센서의 밤 중앙값보다 이만큼 이상 높으면 제외
ANOMALY_DB = 8.0

# 수면 점수 (잠정 — 팀 확정 전)
SCORE_BEST_DB = 40
SCORE_WORST_DB = 65
SCORE_LUX_PENALTY = 5             # 밤 밝기 중앙값 > LUX_REF 이면 -5
SCORE_PEAK_PENALTY_PER = 2        # 하룻밤 평균 피크 1회당 -2
SCORE_PEAK_PENALTY_MAX = 10

# 주거 동네 비교에 쓰는 센서 지역 구분 (CSV '지역' 값)
RESIDENTIAL_RGN = ["residential_area"]
EXCLUDED_RGN = ["parks", "roads_and_parks"]   # 공원·도로변: 동네 대표값 계산에서 제외

RGN_KO = {
    "residential_area": "주거지역", "commercial_area": "상업지역", "industrial_area": "공업지역",
    "main_street": "주요 거리", "traditional_markets": "전통시장", "roads_and_parks": "도로·공원",
    "parks": "공원", "public_facilities": "공공시설",
}

N_PATTERNS = 3
