"""S-DoT 수집: 주간 CSV(백필) + Seoul Open API IotVdata017(증분) → data/hourly/YYYY-MM-DD.parquet

사용:
  python -m pipeline.fetch_sdot csv            # data/raw/S-DoT_NATURE_*.csv 전부 변환
  python -m pipeline.fetch_sdot api --days 3   # 최근 N일 중 없는 날짜를 API로 수집 (어제까지)
  python -m pipeline.fetch_sdot api --since 2026-11-02

저장 형식(시간별, 센서×측정시간 1행):
  sn, ts(측정시간 표기, KST), rgn, cgg, dong, nis_avg, nis_max, lux_avg
CSV와 API의 컬럼 이름은 명세서(Open API 명세서(20250716).xlsx)와 실제 파일 머리글로 확인함.
"""
from __future__ import annotations

import argparse
import datetime as dt
import os
import sys
import time

import pandas as pd
import requests

from pipeline import config as C

CSV_COLS = {
    "시리얼": "sn", "측정시간": "ts", "지역": "rgn", "자치구": "cgg", "행정동": "dong",
    "소음 평균(dB)": "nis_avg", "소음 최대(dB)": "nis_max", "조도 평균(lux)": "lux_avg",
}
API_COLS = {
    "SN": "sn", "MSRMT_HR": "ts", "RGN": "rgn", "CGG": "cgg", "DONG": "dong",
    "AVG_NIS": "nis_avg", "MAX_NIS": "nis_max", "AVG_INILLU": "lux_avg",
}


def _normalize(df: pd.DataFrame) -> pd.DataFrame:
    df = df.copy()
    df["ts"] = pd.to_datetime(df["ts"], format="%Y-%m-%d_%H:%M:%S", errors="coerce")
    for c in ["nis_avg", "nis_max", "lux_avg"]:
        df[c] = pd.to_numeric(df[c], errors="coerce").astype("float32")
    for c in ["sn", "rgn", "cgg", "dong"]:
        df[c] = df[c].astype("string").str.strip()
    df = df.dropna(subset=["ts", "sn"])
    return df.drop_duplicates(subset=["sn", "ts"], keep="last")


def _write_days(df: pd.DataFrame, overwrite: bool = False) -> list[str]:
    C.HOURLY.mkdir(parents=True, exist_ok=True)
    written = []
    for day, part in df.groupby(df["ts"].dt.date):
        path = C.HOURLY / f"{day}.parquet"
        if path.exists() and not overwrite:
            old = pd.read_parquet(path)
            part = pd.concat([old, part]).drop_duplicates(subset=["sn", "ts"], keep="last")
        part = part.sort_values(["ts", "sn"]).reset_index(drop=True)
        for c in ["rgn", "cgg", "dong"]:
            part[c] = part[c].astype("category")
        part.to_parquet(path, compression="zstd", index=False)
        written.append(str(day))
    return written


def ingest_csv() -> list[str]:
    files = sorted(C.RAW.glob(C.CSV_GLOB))
    days: list[str] = []
    for f in files:
        # 데이터 행의 칸 수(64)가 머리글(58)보다 많음 → index_col=False 필수. 인코딩 cp949.
        df = pd.read_csv(f, encoding="cp949", usecols=list(CSV_COLS), dtype=str, index_col=False)
        df = _normalize(df.rename(columns=CSV_COLS))
        days += _write_days(df)
        print(f"[csv] {f.name}: {len(df):,} rows")
    return sorted(set(days))


def _api_get(key: str, start: int, end: int, gu: str, date: str, retries: int = 3) -> dict:
    url = C.SDOT_API.format(key=key, start=start, end=end, gu=gu, date=date)
    for i in range(retries):
        try:
            r = requests.get(url, timeout=60)
            r.raise_for_status()
            return r.json()
        except Exception as e:  # 네트워크 오류는 재시도
            if i == retries - 1:
                raise RuntimeError(f"API 실패 gu={gu} date={date} start={start}: {type(e).__name__}") from None
            time.sleep(2 * (i + 1))
    return {}


def fetch_api_day(key: str, date: str) -> pd.DataFrame:
    """REG_DTTM(등록일시) 날짜 기준으로 25개 구를 모두 수집."""
    rows = []
    for gu in C.GU_EN.values():
        start = 1
        while True:
            j = _api_get(key, start, start + C.SDOT_PAGE - 1, gu, date)
            body = j.get(C.SDOT_SERVICE)
            if body is None:
                code = j.get("RESULT", {}).get("CODE")
                if code == "INFO-200":  # 해당 데이터 없음
                    break
                raise RuntimeError(f"API 응답 이상 gu={gu} date={date}: {code}")
            rows += body.get("row", [])
            total = int(body.get("list_total_count", 0))
            start += C.SDOT_PAGE
            if start > total:
                break
    if not rows:
        return pd.DataFrame(columns=list(API_COLS.values()))
    df = pd.DataFrame(rows)[list(API_COLS)].rename(columns=API_COLS)
    return _normalize(df)


def ingest_api(since: dt.date, until: dt.date, refetch: bool = False) -> list[str]:
    key = os.environ.get("SEOUL_OPENAPI_KEY")
    if not key:
        from dotenv import load_dotenv
        load_dotenv(C.ROOT / ".env")
        key = os.environ.get("SEOUL_OPENAPI_KEY")
    if not key:
        sys.exit("SEOUL_OPENAPI_KEY가 없습니다 (.env 또는 GitHub Secrets)")
    days = []
    d = since
    while d <= until:
        # 등록일시 기준 조회이므로 그날 밤 23:07 측정분까지 포함됨. 하루 뒤 00:07 측정분은 다음 날 조회에 포함.
        if refetch or not (C.HOURLY / f"{d}.parquet").exists() or d >= until - dt.timedelta(days=1):
            df = fetch_api_day(key, d.isoformat())
            print(f"[api] {d}: {len(df):,} rows")
            if len(df):
                days += _write_days(df)
        d += dt.timedelta(days=1)
    return sorted(set(days))


def main(argv=None):
    p = argparse.ArgumentParser()
    sub = p.add_subparsers(dest="cmd", required=True)
    sub.add_parser("csv")
    a = sub.add_parser("api")
    a.add_argument("--days", type=int, default=3)
    a.add_argument("--since")
    a.add_argument("--refetch", action="store_true")
    args = p.parse_args(argv)
    if args.cmd == "csv":
        print(ingest_csv())
    else:
        today = dt.date.today()  # Actions에서는 TZ=Asia/Seoul로 실행
        until = today - dt.timedelta(days=1)
        since = dt.date.fromisoformat(args.since) if args.since else until - dt.timedelta(days=args.days - 1)
        print(ingest_api(since, until, refetch=args.refetch))


if __name__ == "__main__":
    main()
