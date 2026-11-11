"""연도별 소음 정리: S-DoT 연도 zip(2020~2025)·주간 CSV·data/hourly → 연도별 행정동 지표

  python -m pipeline.yearly                 # data/raw 에 있는 모든 연도 처리
  python -m pipeline.yearly --year 2023     # 한 해만

입력(있는 것만 사용):
  data/raw/S-DoT_NATURE_{연도}년(...).zip    연도 묶음 (안의 CSV를 모두 읽음)
  data/raw/S-DoT_NATURE_{연도}.MM.DD-MM.DD.csv  주간 CSV
  data/hourly/{연도}-*.parquet               이미 정리된 시간별 자료(최근 연도)
중간 산출물(커밋 안 함): data/derived/years/{연도}.parquet
출력(커밋):
  web/public/data/years/index.json         연도 목록, 기간, 부분 연도 여부, 서울 중앙값
  web/public/data/years/{연도}.json        행정동별 연간 지표 (지도·리포트용)
  web/public/data/years/{연도}_calendar.json 동별 하룻밤 값 (조용한 밤 달력, 1년)
  web/public/data/years/trends.json        동별 연도별 밤 소음 (추이 그래프)

연도 구분: '밤 날짜'(22시가 시작된 날)의 연도. 행정동 경계는 모든 연도에 ver20261001을 쓴다(과거 경계 변경은 반영 안 함).
"""
from __future__ import annotations

import argparse
import datetime as dt
import io
import json
import re
import zipfile
from pathlib import Path

import numpy as np
import pandas as pd

from pipeline import aggregate as A
from pipeline import clean as CL
from pipeline import config as C
from pipeline import sensors as S

YEARS_RAW = C.DERIVED / "years"
OUT = C.WEB_DATA / "years"
FIRST_YEAR = 2020

# 머리글 이름이 연도·파일마다 다르다(실제 zip 6개로 확인, 2026-11).
#  새 형식(2021-11~): 측정시간, 지역, 자치구, 행정동, 소음 평균/최대, 조도 평균
#  옛 형식(2020-04~2021-10): 시리얼, 소음(dB) 값 하나, 조도(lux), 등록일자/등록 일자. 지역·행정동 없음.
#  옛 형식의 '전송시간'은 숫자가 깨져 있어(2.02E+11) 등록일자를 시간으로 쓴다.
COL_RULES = {
    "sn": ["시리얼"],
    "ts": ["측정시간"],
    "rgn": ["지역"],
    "cgg": ["자치구"],
    "dong": ["행정동"],
    "nis_avg": ["소음 평균", "소음평균"],
    "nis_max": ["소음 최대", "소음최대"],
    "lux_avg": ["조도 평균", "조도평균"],
}
OLD_RULES = {
    "sn": ["시리얼"],
    "ts": ["등록일자", "등록일시", "측정시간"],   # 앞에 있는 이름을 먼저 쓴다
    "nis_avg": ["소음(dB)"],
    "lux_avg": ["조도(lux)"],
}


def _norm(h: str) -> str:
    """머리글 비교용: BOM·띄어쓰기 제거, ㏈→dB (실제 파일에 '소음 (㏈)', '등록 일자' 같은 변형이 있음)"""
    return h.replace("\ufeff", "").replace(" ", "").replace("㏈", "dB").strip().strip('"')


def _find(header: list[str], rules: dict[str, list[str]]) -> dict[str, str]:
    normed = [(_norm(h), h) for h in header]
    out = {}
    for std, keys in rules.items():
        hit = None
        for k in keys:                       # 키 순서가 우선순위
            k = _norm(k)
            hit = next((h for n, h in normed if k in n and h not in out), None)
            if hit:
                break
        if hit is None:
            raise KeyError(f"'{std}' 열을 찾지 못함. 머리글: {header[:15]}")
        out[hit] = std
    return out


def match_columns(header: list[str]) -> dict[str, str]:
    """원본 머리글 → 표준 이름 (새 형식). 필요한 열을 못 찾으면 KeyError."""
    return _find(header, COL_RULES)


def detect_format(header: list[str]) -> str:
    return "new" if any("소음평균" in _norm(h) for h in header) else "old"


def _read_csv_bytes(raw: bytes) -> pd.DataFrame:
    first = raw.split(b"\n", 1)[0]          # 첫 줄만 (중간에서 자르면 한글이 깨질 수 있음)
    enc, errors = None, "strict"
    for e in ("cp949", "utf-8-sig"):
        try:
            head = first.decode(e)
            enc = e
            break
        except UnicodeDecodeError:
            continue
    if enc is None:                          # 둘 다 안 되면 깨진 글자만 바꾸고 계속 (숫자 열은 영향 없음)
        enc, errors = "cp949", "replace"
        head = first.decode(enc, errors="replace")
    header = [h.strip().strip('"') for h in head.split(",")]
    fmt = detect_format(header)
    cmap = _find(header, COL_RULES if fmt == "new" else OLD_RULES)
    if fmt == "new":
        # 2023년 파일은 측정시간이 12시간제(1~12시, 오전·오후 없음)라 등록일시(24시간제)도 함께 읽어 둔다
        reg = next((h for h in header if _norm(h) in ("등록일시", "등록일자") and h not in cmap), None)
        if reg:
            cmap[reg] = "reg"
    df = pd.read_csv(io.BytesIO(raw), encoding=enc, encoding_errors=errors, usecols=list(cmap), dtype=str, index_col=False)
    df = df.rename(columns=cmap)
    if fmt == "old":
        for c in ["rgn", "cgg", "dong"]:
            df[c] = pd.NA
        df["nis_max"] = np.nan
    t = df["ts"].astype("string").str.replace("_", " ", regex=False).str.replace(".", "-", regex=False)
    df["ts"] = pd.to_datetime(t, format="mixed", errors="coerce")
    if "reg" in df:
        reg = pd.to_datetime(df.pop("reg").astype("string"), format="mixed", errors="coerce")
        if df["ts"].dt.hour.max() <= 12 and reg.notna().mean() > 0.9 and reg.dt.hour.max() > 12:
            df["ts"] = reg                        # 12시간제 측정시간 대신 등록일시(측정 1분 뒤 기록)를 쓴다
    for c in ["nis_avg", "nis_max", "lux_avg"]:
        df[c] = pd.to_numeric(df[c], errors="coerce").astype("float32")
    for c in ["sn", "rgn", "cgg", "dong"]:
        df[c] = df[c].astype("string").str.strip()
    df["fmt"] = fmt
    return df.dropna(subset=["ts", "sn"])[["sn", "ts", "rgn", "cgg", "dong", "nis_avg", "nis_max", "lux_avg", "fmt"]]


def to_hourly(df: pd.DataFrame) -> pd.DataFrame:
    """한 시간에 여러 번 찍힌 기록(2023년 등)을 센서·시간당 한 행으로: 소음 평균은 에너지 평균, 최대는 최댓값, 조도는 중앙값.
    시간 표기는 지금 자료와 같게 '구간 끝 정각 + 7분'으로 맞춘다."""
    hs = df["ts"].dt.round("h")      # 07분·03분·정각 표기를 모두 가장 가까운 정각(구간 끝)으로
    e = np.power(10.0, df["nis_avg"].astype("float64") / 10.0)
    g = df.assign(_hs=hs, _e=e).groupby(["sn", "_hs"], sort=False)
    out = g.agg(rgn=("rgn", "last"), cgg=("cgg", "last"), dong=("dong", "last"), _e=("_e", "mean"),
                nis_max=("nis_max", "max"), lux_avg=("lux_avg", "median"), fmt=("fmt", "last")).reset_index()
    out["nis_avg"] = (10 * np.log10(out.pop("_e"))).astype("float32")
    out["ts"] = out.pop("_hs") + pd.Timedelta(minutes=7)
    return out


def attach_sensor_attrs(df: pd.DataFrame, ref: pd.DataFrame) -> pd.DataFrame:
    """옛 형식(지역·자치구·행정동 없음)에 같은 시리얼의 다른 연도 값을 붙인다."""
    if ref.empty:
        return df
    m = ref.dropna(subset=["rgn"]).sort_values("ts").groupby("sn")[["rgn", "cgg", "dong"]].last()
    miss = df["rgn"].isna()
    for c in ["rgn", "cgg", "dong"]:
        df.loc[miss, c] = df.loc[miss, "sn"].map(m[c])
    return df


def raw_sources(year: int) -> list[Path]:
    srcs = sorted(C.RAW.glob(f"S-DoT_NATURE_{year}년*.zip"))
    srcs += sorted(C.RAW.glob(f"S-DoT_NATURE_{year}.*.csv"))
    return srcs


def collect_year(year: int) -> pd.DataFrame | None:
    """한 해의 시간별 원자료를 모아 data/derived/years/{연도}.parquet 로 저장 (밤 날짜가 그 해인 것 + 앞뒤 경계 포함)."""
    parts = []
    for src in raw_sources(year):
        if src.suffix == ".zip":
            with zipfile.ZipFile(src) as z:
                for name in z.namelist():
                    if name.lower().endswith(".csv"):
                        parts.append(_read_csv_bytes(z.read(name)))
                        print(f"[yearly] {year} {src.name} › {name}: {len(parts[-1]):,}행", flush=True)
        else:
            parts.append(_read_csv_bytes(src.read_bytes()))
            print(f"[yearly] {year} {src.name}: {len(parts[-1]):,}행", flush=True)
    hourly = sorted(C.HOURLY.glob(f"{year}-*.parquet")) + sorted(C.HOURLY.glob(f"{year + 1}-01-01.parquet"))
    for f in hourly:
        parts.append(pd.read_parquet(f))
    if not parts:
        return None
    df = pd.concat(parts, ignore_index=True)
    if "fmt" not in df:
        df["fmt"] = "new"
    df["fmt"] = df["fmt"].fillna("new")
    df = to_hourly(df)
    if df["rgn"].isna().any():
        df = attach_sensor_attrs(df, sensor_reference())
        print(f"[yearly] {year}: 옛 형식 {int((df['fmt'] == 'old').sum()):,}행, 지역 구분을 찾지 못한 행 {int(df['rgn'].isna().sum()):,}", flush=True)
    YEARS_RAW.mkdir(parents=True, exist_ok=True)
    for c in ["rgn", "cgg", "dong"]:
        df[c] = df[c].astype("category")
    df.to_parquet(YEARS_RAW / f"{year}.parquet", compression="zstd", index=False)
    return df


def sensor_reference() -> pd.DataFrame:
    """시리얼 → 지역·자치구·행정동 참조표: 지금 시간별 자료 + 이미 만든 연도 중간 파일."""
    parts = [pd.read_parquet(f, columns=["sn", "ts", "rgn", "cgg", "dong"]) for f in sorted(C.HOURLY.glob("*.parquet"))[-14:]]
    parts += [pd.read_parquet(f, columns=["sn", "ts", "rgn", "cgg", "dong"]) for f in sorted(YEARS_RAW.glob("*.parquet"))]
    return pd.concat(parts, ignore_index=True) if parts else pd.DataFrame(columns=["sn", "ts", "rgn", "cgg", "dong"])


def summarize_year(year: int, df: pd.DataFrame, feats) -> dict:
    df = CL.prepare(df)
    df = df[df["nd"].isna() | (df["nd"].dt.year == year)]          # 밤 날짜 기준 그 해만
    df = df[(df["hs"].dt.year == year) | df["nd"].notna()]
    meta_s = CL.sensor_meta(df)
    night, full, st, log = CL.clean(df)
    sm = A.sensor_metrics(night)
    sensors = S.assign_dongs(meta_s.join(st).join(sm), feats)
    basis = A.choose_basis(sensors)
    dongs = A.dong_table(night, full, basis, feats)
    calendar = {c: r.pop("nights", {}) for c, r in dongs.items()}
    keep = ["code", "name", "gu", "n_sensors", "basis", "l_night", "by_hour", "heatmap", "score",
            "peaks_per_night", "lux", "weekend_effect", "quiet_ratio", "months"]
    slim = {c: {k: r[k] for k in keep if k in r} for c, r in dongs.items()}
    nds = night["nd"].dropna()
    vals = [r["l_night"] for r in slim.values() if r.get("l_night") is not None]
    info = {
        "year": year,
        "start": nds.min().date().isoformat() if len(nds) else None,
        "end": nds.max().date().isoformat() if len(nds) else None,
        "nights": int(nds.nunique()),
        "partial": bool(nds.nunique() < 330),
        "old_format_share": round(float((df.get("fmt", pd.Series(dtype=str)) == "old").mean()), 3) if "fmt" in df else 0.0,
        "sensors_used": int(len(basis)),
        "dongs_with_data": len(vals),
        "seoul_median": A._r(float(np.median(vals))) if vals else None,
        "excluded_nights": sum(1 for x in log if x["type"] == "night"),
        "excluded_sensors": sum(1 for x in log if x["type"] == "sensor"),
        "sources": [p.name for p in raw_sources(year)] + (["data/hourly"] if list(C.HOURLY.glob(f"{year}-*.parquet")) else []),
    }
    return {"info": info, "dongs": slim, "calendar": calendar}


def compact_calendar(cal: dict, info: dict) -> dict:
    """{동: {날짜: 값}} → {start, days, dongs: {동: [값...]}} (날짜 키를 빼서 크기를 줄임)"""
    if not info.get("start"):
        return {"start": None, "days": 0, "dongs": {}}
    start = pd.Timestamp(info["start"])
    days = (pd.Timestamp(info["end"]) - start).days + 1
    out = {}
    for code, nights in cal.items():
        if not nights:
            continue
        arr = [None] * days
        for d, v in nights.items():
            i = (pd.Timestamp(d) - start).days
            if 0 <= i < days:
                arr[i] = v
        out[code] = arr
    return {"start": info["start"], "days": days, "dongs": out}


def _dump(path: Path, obj):
    from pipeline.build import _json_default
    path.parent.mkdir(parents=True, exist_ok=True)
    s = json.dumps(obj, ensure_ascii=False, separators=(",", ":"), default=_json_default, allow_nan=False)
    path.write_text(s, encoding="utf-8")
    print(f"  {path.relative_to(C.ROOT)}: {len(s) / 1024:.0f} KB")


def available_years() -> list[int]:
    ys = set()
    for p in C.RAW.glob("S-DoT_NATURE_*"):
        m = re.match(r"S-DoT_NATURE_(\d{4})", p.name)
        if m:
            ys.add(int(m.group(1)))
    for p in C.HOURLY.glob("*.parquet"):
        ys.add(int(p.stem[:4]))
    for p in YEARS_RAW.glob("*.parquet"):
        ys.add(int(p.stem))
    return sorted(y for y in ys if FIRST_YEAR <= y < this_year())


def this_year() -> int:
    """진행 중인 해는 연도별 보기에 넣지 않는다(계절이 다 들어 있지 않아 다른 해와 비교가 안 됨)."""
    return dt.datetime.now(dt.timezone(dt.timedelta(hours=9))).year


def run(years: list[int] | None = None, recollect: bool = False):
    feats = S.load_boundaries()
    years = [y for y in (years or available_years()) if y < this_year()]
    index_path = OUT / "index.json"
    index = {y["year"]: y for y in (json.loads(index_path.read_text(encoding="utf-8")) if index_path.exists() else [])
             if y["year"] < this_year()}
    for f in OUT.glob("*.json"):
        m = re.match(r"(\d{4})", f.stem)
        if m and int(m.group(1)) >= this_year():
            f.unlink()
    for y in sorted(years, reverse=True):     # 새 연도부터: 옛 형식에 붙일 센서 정보를 먼저 확보
        cache = YEARS_RAW / f"{y}.parquet"
        newer_raw = any(p.stat().st_mtime > cache.stat().st_mtime for p in raw_sources(y)) if cache.exists() else True
        df = pd.read_parquet(cache) if cache.exists() and not recollect and not newer_raw and y < max(years) else collect_year(y)
        if df is None or df.empty:
            print(f"[yearly] {y}: 자료 없음")
            continue
        res = summarize_year(y, df, feats)
        if not recollect and y in index and index[y].get("nights", 0) > res["info"]["nights"]:
            # 예: 자동 갱신(매일 받은 자료만)이 연도 zip으로 만든 더 완전한 결과를 덮어쓰지 않게
            print(f"[yearly] {y}: 기존 결과(밤 {index[y]['nights']}일)가 더 완전해서 유지")
            continue
        _dump(OUT / f"{y}.json", res["dongs"])
        _dump(OUT / f"{y}_calendar.json", compact_calendar(res["calendar"], res["info"]))
        index[y] = res["info"]
        _dump(index_path, [index[k] for k in sorted(index)])   # 중간에 멈춰도 끝난 해는 남게
        print(f"[yearly] {y}: 밤 {res['info']['nights']}일, 동 {res['info']['dongs_with_data']}곳, 서울 중앙값 {res['info']['seoul_median']}dB")
    _dump(index_path, [index[k] for k in sorted(index)])
    # 동별 연도 추이
    trends: dict[str, dict[str, float | None]] = {}
    for y in sorted(index):
        f = OUT / f"{y}.json"
        if not f.exists():
            continue
        for code, r in json.loads(f.read_text(encoding="utf-8")).items():
            trends.setdefault(code, {})[str(y)] = r.get("l_night")
    _dump(OUT / "trends.json", trends)


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--year", type=int, action="append")
    p.add_argument("--recollect", action="store_true", help="원본을 다시 읽어 중간 파일을 새로 만듦")
    a = p.parse_args()
    run(a.year, a.recollect)
