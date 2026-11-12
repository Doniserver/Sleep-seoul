"""서울 전역 건물 수집 (브이월드 2D 데이터 API `LT_C_BLDGINFO`, GIS건물통합정보).

    python -m pipeline.fetch_bldg        # → data/브이월드/bldg/{칸}.parquet (칸마다 저장, 다시 실행하면 이어서 받음)

속성(실제 응답 확인, 2026-11): height(높이 m), grnd_flr(지상 층수), usability(용도 코드), archarea(건축면적),
useapr_day(사용승인일 YYYYMMDD), geometry(다각형). 높이가 0이면 층수 × 3m로 본다.
"""
from __future__ import annotations

import os
import time

import numpy as np
import pandas as pd
import requests
import shapely
from dotenv import load_dotenv

from . import config as C
from .fetch_roads import SEOUL

URL = "https://api.vworld.kr/req/data"
STEP = 0.02
OUT = C.VWORLD / "bldg"


def building_height(height, floors) -> float:
    """높이(m). 높이 값이 없거나 0이면 지상 층수 × 3m, 둘 다 없으면 0."""
    try:
        h = float(height)
    except (TypeError, ValueError):
        h = 0.0
    if h > 0:
        return h
    try:
        return max(float(floors), 0.0) * 3.0
    except (TypeError, ValueError):
        return 0.0


def fetch_tile(sess, key, domain, box) -> pd.DataFrame | None:
    rows, page = [], 1
    while True:
        r = None
        for a in range(5):
            try:
                r = sess.get(URL, params=dict(service="data", request="GetFeature", data="LT_C_BLDGINFO", format="json", size=1000,
                                              page=page, geometry="true", crs="EPSG:4326", domain=domain, key=key,
                                              geomFilter="BOX(%.4f,%.4f,%.4f,%.4f)" % box), timeout=120).json()["response"]
                break
            except Exception:
                time.sleep(3 * (a + 1))
        if r is None or r["status"] not in ("OK", "NOT_FOUND"):
            return None
        if r["status"] == "NOT_FOUND":
            break
        for f in r["result"]["featureCollection"]["features"]:
            p = f["properties"]
            try:
                g = shapely.geometry.shape(f["geometry"])
            except Exception:
                continue
            rows.append(dict(id=f["id"], h=building_height(p.get("height"), p.get("grnd_flr")), use=str(p.get("usability") or ""),
                             apr=str(p.get("useapr_day") or ""), wkb=shapely.to_wkb(g.simplify(0.00001))))
        if page >= int(r["page"]["total"]):
            break
        page += 1
    return pd.DataFrame(rows, columns=["id", "h", "use", "apr", "wkb"])


def main():
    load_dotenv(C.ROOT / ".env")
    key = (os.environ.get("VITE_VWORLD_KEY") or "").strip()
    if not key:
        raise SystemExit(".env에 VITE_VWORLD_KEY가 없습니다")
    domain = (os.environ.get("VWORLD_DOMAIN") or "localhost:5173").strip()
    OUT.mkdir(parents=True, exist_ok=True)
    sess = requests.Session()
    x0, y0, x1, y1 = SEOUL
    boxes = [(round(x, 4), round(y, 4), round(x + STEP, 4), round(y + STEP, 4)) for x in np.arange(x0, x1, STEP) for y in np.arange(y0, y1, STEP)]
    total = 0
    for n, b in enumerate(boxes, 1):
        f = OUT / f"{b[0]:.2f}_{b[1]:.2f}.parquet"
        if f.exists():
            continue
        df = fetch_tile(sess, key, domain, b)
        if df is None:
            print(f"  실패: {b} (다시 실행하면 이어서 받음)", flush=True)
            continue
        df.to_parquet(f, index=False)
        total += len(df)
        if n % 20 == 0:
            print(f"  {n}/{len(boxes)} 칸, 이번 실행 {total:,}동", flush=True)
    print("끝", flush=True)


if __name__ == "__main__":
    main()
