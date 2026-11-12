"""도로 중심선 수집 (브이월드 2D 데이터 API, 국토지리정보원 연속수치지도 도로중심선).

    python -m pipeline.fetch_roads            # 서울 전체, 2차로 이상 → data/derived/roads.parquet

확인한 것 (실제 응답, 2026-11):
  - 주소: https://api.vworld.kr/req/data?service=data&request=GetFeature&data=LT_L_N3A0020000
  - 한 번에 최대 1000건, page로 넘김. geomFilter=BOX(minLon,minLat,maxLon,maxLat), attrFilter=rdln:>=:2
  - 속성: ufid(고유번호), name(도로 이름), rdln(차로 수), rvwd(도로 폭 m), rddv(도로 구분 코드), scls
  - geometry: MultiLineString (경도, 위도)
도로는 자주 바뀌지 않으므로 매일 돌리지 않는다 (필요할 때 손으로 다시 실행).
"""
from __future__ import annotations

import json
import os
import time

import pandas as pd
import requests
from dotenv import load_dotenv

from . import config as C

URL = "https://api.vworld.kr/req/data"
LAYER = "LT_L_N3A0020000"
SEOUL = (126.76, 37.41, 127.19, 37.72)   # minLon, minLat, maxLon, maxLat
STEP = 0.04                               # 한 칸 크기(도). 한 칸씩 나눠서 요청
MIN_LANES = 2
OUT = C.DERIVED / "roads.parquet"


def tiles(bbox=SEOUL, step=STEP):
    x0, y0, x1, y1 = bbox
    nx = round((x1 - x0) / step + 0.4999)
    ny = round((y1 - y0) / step + 0.4999)
    for i in range(nx):
        for j in range(ny):
            yield (round(x0 + i * step, 6), round(y0 + j * step, 6),
                   round(min(x0 + (i + 1) * step, x1), 6), round(min(y0 + (j + 1) * step, y1), 6))


def parse_feature(f: dict) -> dict | None:
    """응답의 도로 한 줄 → 우리가 쓰는 모양. 차로 수·좌표가 없으면 None."""
    p = f.get("properties") or {}
    g = f.get("geometry") or {}
    try:
        lanes = int(float(p.get("rdln")))
    except (TypeError, ValueError):
        return None
    try:
        width = float(p.get("rvwd"))
    except (TypeError, ValueError):
        width = float("nan")
    if g.get("type") == "LineString":
        lines = [g.get("coordinates") or []]
    elif g.get("type") == "MultiLineString":
        lines = g.get("coordinates") or []
    else:
        return None
    lines = [[[round(float(x), 6), round(float(y), 6)] for x, y in ln] for ln in lines if len(ln) >= 2]
    if not lines or not p.get("ufid"):
        return None
    return {"ufid": str(p["ufid"]), "name": str(p.get("name") or ""), "lanes": lanes, "width": width,
            "rddv": str(p.get("rddv") or ""), "lines": json.dumps(lines)}


def fetch_tile(sess, key, domain, box) -> list[dict]:
    out, page = [], 1
    while True:
        params = dict(service="data", request="GetFeature", data=LAYER, format="json", size=1000, page=page,
                      geometry="true", crs="EPSG:4326", geomFilter="BOX(%s,%s,%s,%s)" % box,
                      attrFilter=f"rdln:>=:{MIN_LANES}", domain=domain, key=key)
        for attempt in range(4):
            try:
                r = sess.get(URL, params=params, timeout=90).json()["response"]
                break
            except Exception:
                if attempt == 3:
                    raise
                time.sleep(2 * (attempt + 1))
        if r["status"] == "NOT_FOUND":
            return out
        if r["status"] != "OK":
            raise RuntimeError(f"브이월드 오류: {r.get('error')}")
        out += r["result"]["featureCollection"]["features"]
        if page >= int(r["page"]["total"]):
            return out
        page += 1


def main():
    load_dotenv(C.ROOT / ".env")
    key = (os.environ.get("VITE_VWORLD_KEY") or "").strip()
    if not key:
        raise SystemExit(".env에 VITE_VWORLD_KEY가 없습니다")
    domain = (os.environ.get("VWORLD_DOMAIN") or "localhost:5173").strip()
    sess, rows = requests.Session(), {}
    boxes = list(tiles())
    for n, box in enumerate(boxes, 1):
        for f in fetch_tile(sess, key, domain, box):
            rec = parse_feature(f)
            if rec:
                rows[rec["ufid"]] = rec
        if n % 20 == 0 or n == len(boxes):
            print(f"  {n}/{len(boxes)} 칸, 도로 {len(rows):,}줄")
    df = pd.DataFrame(rows.values())
    OUT.parent.mkdir(parents=True, exist_ok=True)
    df.to_parquet(OUT, index=False)
    print(f"저장: {OUT} ({len(df):,}줄) 차로 수 분포: {df.lanes.value_counts().sort_index().to_dict()}")


if __name__ == "__main__":
    main()
