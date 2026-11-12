"""파이프라인 공통 설정. 숫자 기준은 docs/methodology.md와 함께 바꿀 것."""
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
# 자료 폴더는 "어디서 받았는가"로 나눈다. 폴더마다 무엇이 들어 있는지는 data/README.md 에 적는다.
DATA = ROOT / "data"
SEOUL = DATA / "서울열린데이터광장"           # 서울시 S-DoT
SDOT_RAW = SEOUL / "원본"                   # 연도 zip, 주간 CSV, 설치 위치정보, API 명세서 (커밋 안 함)
LOCATIONS = SEOUL / "센서위치_사본"          # 설치 위치정보 사본 (자동 갱신용, 커밋함)
HOURLY = SEOUL / "매일수집"                 # API로 매일 받은 시간별 소음·조도 (일 단위 parquet, 커밋함)
YEARS_DERIVED = SEOUL / "연도별정리"         # 연도 zip을 풀어 정리한 시간 자료 (커밋 안 함)
VWORLD = DATA / "브이월드"                  # 국토교통부 브이월드: 도로중심선, 철도시설, 건물 (커밋 안 함)
SBIZ = DATA / "공공데이터포털" / "상가정보"    # 소상공인시장진흥공단 상가정보 (커밋 안 함)
KAPT = DATA / "공공데이터포털" / "공동주택"    # 국토교통부 공동주택 기본정보 (커밋 안 함)
BOUNDARY_DIR = DATA / "공개저장소_행정동경계"  # vuski/admdongkor (커밋 안 함)
SCRATCH = DATA / "분석임시"                 # 계산 중 잠깐 쓰는 파일, 조사용 임시 파일 (커밋 안 함)
WEB_DATA = ROOT / "web" / "public" / "data"

BOUNDARY_FILE = BOUNDARY_DIR / "HangJeongDong_ver20261001.geojson"
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
QUIET_NIGHT_DB = 50               # 조용한 밤 기준 (기종 보정 후 분포 기준. 동 값 중앙 약 52dB)
LUX_REF = 10                      # 주거지역 침입광 참고선
LUX_BROKEN = 2000                 # 밤 조도 중앙값이 이보다 크면 조도 센서 이상으로 보고 제외
WHO_LINES = {"who_target": 40, "who_road": 45, "who_interim": 55}

# 센서 기종 보정 (docs/data-check.md 9절). 시리얼 앞 3글자로 기종을 구분한다.
# V02 기종은 같은 자리의 OC3 기종·서울시 공식 통계보다 낮게 읽는다 → 일정한 값을 더해 OC3 척도로 맞춘다.
# 근거: 위치 요인 통제 후 차이 8.5dB (나란한 쌍 10.6, 주거 센서 중앙값 9.3). 법정 측정소 비교로 확정 예정.
DEVICE_OFFSET_DB = {"V02": 8.5}
# 2020년 V02는 2021년 이후보다 2.3dB 높게 기록됨(같은 센서 792개) → 그만큼 덜 더한다
DEVICE_OFFSET_BY_YEAR = {"V02": {2020: 6.2}}

# 이상치(공사·축제 등): 센서별 하룻밤 L_night가 그 센서의 밤 중앙값보다 이만큼 이상 높으면 제외
ANOMALY_DB = 8.0

# 수면 점수 (잠정 — 팀 확정 전)
SCORE_BEST_DB = 45                # 주거지역 밤 환경기준(45dB) 이하면 만점. 기종 보정 전에는 40
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
