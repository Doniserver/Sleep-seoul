# 잠 잘 오는 동네

서울 S-DoT 도시센서 약 1,100개의 시간별 소음·조도로 **동네별 밤(22~06시) 바깥 환경**을 비교하고, 공동주택 사용승인 연도로 **층간소음 위험을 추정**해 함께 보여주는 지도 웹사이트입니다. (서울대 빅데이터 핀테크 수업 팀 프로젝트)

> **읽기 전에**
> - 소음은 길가에 달린 센서로 잰 **동네 바깥 환경**입니다. 집 안 소음이 아닙니다.
> - S-DoT는 **간이측정기**(성능인증 1등급)입니다. 법정 측정이 아니라 **비교용 지표**입니다.
> - 층간소음 등급은 측정값이 아니라 **건축 시기로 추정**한 값입니다.
> - S-DoT 데이터를 이용한 팀의 분석 결과이며 서울시의 공식 입장이 아닙니다.

## 화면

| 화면 | 내용 |
|---|---|
| 서울의 밤 지도 | 행정동별 밤 소음 색 지도, 22~06시 시간 슬라이더·재생, 월별 보기, 3D 기둥 토글, 센서 위치 |
| 동네 리포트 | 밤 소음과 WHO 40·45·55dB 대비, 수면 점수, 피크 횟수, 밤 밝기, 주말 효과, 소음 패턴 유형, 요일×시간 히트맵, 조용한 밤 달력, 층간소음 추정 |
| 두 동네 비교 | 이사 후보 두 곳의 지표표, 밤 시간대별 선 그래프, 히트맵 |
| 방법·한계 | 산식, 기준선, 데이터 정리 규칙, 출처 |

## 데이터

| 데이터 | 출처 | 쓰는 곳 |
|---|---|---|
| S-DoT 환경정보 주간 CSV + Open API `IotVdata017` | [서울 열린데이터광장](https://data.seoul.go.kr/dataList/OA-15969/S/1/datasetView.do) (공공누리 1유형) | 소음·조도 |
| S-DoT 설치 위치정보.xlsx | 같은 페이지 첨부 | 센서 → 행정동 |
| 행정동 경계 ver20261001 | [vuski/admdongkor](https://github.com/vuski/admdongkor) (CC BY 4.0) | 지도 |
| 공동주택 단지 목록·기본 정보(K-APT) | 공공데이터포털 국토교통부 | 층간소음 추정 |

## 폴더

```
pipeline/          수집·정제·집계·분류 (Python)
  fetch_sdot.py      CSV 백필 + API 증분 → data/hourly/YYYY-MM-DD.parquet
  fetch_buildings.py 공동주택 → web/public/data/buildings.json
  clean.py           결측·고장·이상치 밤 제거 (기록 남김)
  aggregate.py       센서 → 행정동 (중앙값, 보간 없음)
  classify.py        7×24 소음 모양 k-means 분류
  build.py           전체 빌드 → web/public/data/*.json
  verify.py          화면 숫자를 원본에서 다시 계산해 비교
  tests/             단위 테스트 (pytest)
data/hourly/       정제된 시간별 소음·조도 (일 단위 parquet, 커밋)
data/locations/    센서 설치 위치 (CI용)
data/raw/          원본 (커밋 안 함)
web/               Vite + TypeScript + MapLibre + D3
docs/              data-check.md(Phase 0), methodology.md(산식)
```

## 로컬 실행

```bash
python3 -m venv .venv && .venv/bin/pip install -r requirements.txt
cp .env.example .env    # 키 입력
.venv/bin/python -m pytest -q pipeline/tests
.venv/bin/python -m pipeline.fetch_sdot csv          # data/raw의 주간 CSV 변환
.venv/bin/python -m pipeline.fetch_sdot api --days 3 # 최근 3일 API 수집
.venv/bin/python -m pipeline.fetch_buildings         # (단지 목록 API 승인 후)
.venv/bin/python -m pipeline.build && .venv/bin/python -m pipeline.verify
cd web && npm ci && npm run dev
```

`data/raw/`에 필요한 파일: S-DoT 주간 CSV, `설치 위치정보.xlsx`, `boundary/HangJeongDong_ver20261001.geojson`.

## 자동 갱신·배포 (GitHub Actions)

`.github/workflows/update.yml`이 매일 06:30(KST)에 실행됩니다.
테스트 → 최근 3일 API 수집 → 빌드 → 숫자 검증 → 데이터 커밋 → GitHub Pages 배포 순서입니다.

처음 한 번 할 일:
1. 저장소 **Settings → Secrets and variables → Actions**에 `SEOUL_OPENAPI_KEY`를 등록합니다. 공동주택까지 자동화하려면 `DATA_GO_KR_KEY`도 등록합니다.
2. **Settings → Pages → Source**를 **GitHub Actions**로 바꿉니다.
3. **Actions** 탭에서 워크플로를 한 번 수동 실행(Run workflow)합니다.

## 상태 (2026-11-10)

- 데이터 기간: 2026-10-11 밤 ~ 11-08 밤 (29일). 12개월은 주간 CSV를 더 넣어야 합니다.
- 층간소음 레이어: 공동주택 **단지 목록** API 승인 대기 중이라 화면에 "준비 중"으로 표시됩니다.
- AI 동네 리포트 문장: 보류. `report` 칸은 비어 있고 화면에 "준비 중"으로 표시됩니다.
- 수면 점수 가중치는 잠정값입니다(팀 확정 필요).
