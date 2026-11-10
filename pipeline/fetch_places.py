"""생활시설: 소상공인시장진흥공단 상가(상권)정보 API → 동별 건물·가게 파일

  python -m pipeline.fetch_places            # API로 서울 전체 수집 후 파일 생성
  python -m pipeline.fetch_places --build    # 이미 받은 data/derived/stores.parquet로 파일만 다시 생성

API: apis.data.go.kr/B553077/api/open/sdsc2/storeListInDong (divId=signguCd, key=시군구코드)
응답 필드(실제 응답으로 확인): bizesNm, brchNm, indsLclsNm, indsSclsNm, adongCd, bldMngNo, bldNm,
  flrNo, hoNo, rdnmAdr, lon, lat. 헤더 stdrYm = 데이터 기준 연월.

출력(web/public/data):
  places/{행정동코드}.json  [[lat, lon, 건물명, [[분류번호, 상호, 층, 업종], ...]], ...]  (건물 단위로 묶음)
  places_summary.json       동별 분류 개수, 서울 동 중앙값, 기준 연월, 분류 목록
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time

import numpy as np
import pandas as pd
import requests
from shapely import STRtree
from shapely.geometry import Point, shape

from pipeline import config as C
from pipeline import sensors as S
from pipeline.places_categories import CAT_INDEX, CATEGORIES, categorize

URL = "https://apis.data.go.kr/B553077/api/open/sdsc2/storeListInDong"
STORE_FILE = C.DERIVED / "stores.parquet"
KEEP = ["bizesId", "bizesNm", "brchNm", "indsLclsNm", "indsSclsNm", "adongCd", "bldMngNo", "bldNm",
        "flrNo", "hoNo", "rdnmAdr", "lon", "lat"]


def _key() -> str:
    k = os.environ.get("DATA_GO_KR_KEY")
    if not k:
        from dotenv import load_dotenv
        load_dotenv(C.ROOT / ".env")
        k = os.environ.get("DATA_GO_KR_KEY")
    if not k:
        sys.exit("DATA_GO_KR_KEY가 없습니다")
    return k


def _page(key: str, sgg: str, page: int, rows: int = 1000) -> dict:
    for i in range(4):
        try:
            r = requests.get(URL, params={"serviceKey": key, "type": "json", "divId": "signguCd", "key": sgg,
                                          "numOfRows": rows, "pageNo": page}, timeout=90)
            if r.status_code == 200:
                return r.json()
        except (requests.RequestException, ValueError):
            pass
        time.sleep(3 * (i + 1))
    raise RuntimeError(f"상가정보 API 실패 sgg={sgg} page={page}")


def fetch_all() -> tuple[pd.DataFrame, str]:
    key = _key()
    sggs = sorted({f["properties"]["sgg"] for f in S.load_boundaries()})
    rows, ym = [], ""
    for sgg in sggs:
        page, got = 1, 0
        while True:
            j = _page(key, sgg, page)
            ym = j.get("header", {}).get("stdrYm", ym)
            items = j.get("body", {}).get("items", []) or []
            rows += [{k: it.get(k) for k in KEEP} for it in items]
            got += len(items)
            total = int(j.get("body", {}).get("totalCount", 0) or 0)
            if got >= total or not items:
                break
            page += 1
        print(f"[places] {sgg}: {got:,}곳 (누적 {len(rows):,})", flush=True)
    df = pd.DataFrame(rows).drop_duplicates("bizesId")
    df["lon"] = pd.to_numeric(df["lon"], errors="coerce")
    df["lat"] = pd.to_numeric(df["lat"], errors="coerce")
    df = df.dropna(subset=["lon", "lat"])
    df.attrs["stdrYm"] = ym
    C.DERIVED.mkdir(parents=True, exist_ok=True)
    df.to_parquet(STORE_FILE, index=False)
    (C.DERIVED / "stores_meta.json").write_text(json.dumps({"stdrYm": ym}), encoding="utf-8")
    return df, ym


def _floor_key(f: str) -> tuple:
    f = (f or "").strip()
    if not f:
        return (1, 999)
    neg = f.upper().startswith("B") or f.startswith("지하") or f.startswith("-")
    digits = "".join(ch for ch in f if ch.isdigit())
    n = int(digits) if digits else 0
    return (0, -n if neg else n)


def group_buildings(df: pd.DataFrame) -> list:
    """가게들을 건물 단위로 묶음. 건물관리번호가 없으면 좌표(약 1m)로 묶는다."""
    d = df.copy()
    key = d["bldMngNo"].fillna("").astype(str)
    coord = d["lat"].round(5).astype(str) + "," + d["lon"].round(5).astype(str)
    d["_k"] = np.where(key.str.len() > 0, key, coord)
    out = []
    for _, g in d.groupby("_k", sort=False):
        g = g.assign(_f=g["flrNo"].map(_floor_key)).sort_values(["_f", "name"])
        name = next((n for n in g["bldNm"].fillna("") if n), "")
        stores = [[CAT_INDEX[c], n, (f or "").strip(), s] for c, n, f, s in zip(g["cat"], g["name"], g["flrNo"].fillna(""), g["scls"].fillna(""))]
        out.append([round(float(g["lat"].mean()), 6), round(float(g["lon"].mean()), 6), name, stores])
    return out


def build(df: pd.DataFrame, ym: str) -> dict:
    feats = S.load_boundaries()
    geoms = [shape(f["geometry"]) for f in feats]
    tree = STRtree(geoms)
    codes = [f["properties"]["adm_cd2"] for f in feats]
    # 행정동은 좌표로 다시 판정(우리 지도 경계 ver20261001과 맞추기 위해)
    pts = [Point(x, y) for x, y in zip(df["lon"], df["lat"])]
    idx = tree.query(pts, predicate="within")
    adm = np.full(len(df), None, dtype=object)
    adm[idx[0]] = np.array(codes, dtype=object)[idx[1]]
    df = df.assign(adm=adm).dropna(subset=["adm"])
    df = df.assign(
        cat=[categorize(l, s) for l, s in zip(df["indsLclsNm"], df["indsSclsNm"])],
        name=[(n or "").strip() + (f" {b.strip()}" if b and b.strip() else "") for n, b in zip(df["bizesNm"], df["brchNm"])],
        scls=df["indsSclsNm"].fillna("").str.strip(),
    )
    out_dir = C.WEB_DATA / "places"
    out_dir.mkdir(parents=True, exist_ok=True)
    for old in out_dir.glob("*.json"):
        old.unlink()
    counts = {}
    for code, g in df.groupby("adm"):
        b = group_buildings(g)
        (out_dir / f"{code}.json").write_text(json.dumps(b, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
        counts[code] = {k: int(v) for k, v in g["cat"].value_counts().items()}
    cats = [k for k, _, _ in CATEGORIES]
    med = {k: float(np.median([counts.get(c, {}).get(k, 0) for c in codes])) for k in cats}
    summary = {
        "stdrYm": ym, "total": int(len(df)),
        "categories": [{"key": k, "name": n, "default": d} for k, n, d in CATEGORIES],
        "seoul_median": med, "dongs": counts,
        "source": {"name": "소상공인시장진흥공단 상가(상권)정보", "url": "https://www.data.go.kr/data/15012005/openapi.do"},
    }
    (C.WEB_DATA / "places_summary.json").write_text(json.dumps(summary, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    size = sum(p.stat().st_size for p in out_dir.glob("*.json"))
    print(f"[places] 가게 {len(df):,}곳 → 동 파일 {len(counts)}개, {size / 1e6:.1f}MB, 기준 {ym}")
    return summary


def main(argv=None):
    p = argparse.ArgumentParser()
    p.add_argument("--build", action="store_true", help="API 호출 없이 저장된 파일로 다시 생성")
    a = p.parse_args(argv)
    if a.build:
        df = pd.read_parquet(STORE_FILE)
        ym = json.loads((C.DERIVED / "stores_meta.json").read_text(encoding="utf-8")).get("stdrYm", "")
    else:
        df, ym = fetch_all()
    build(df, ym)


if __name__ == "__main__":
    main()
