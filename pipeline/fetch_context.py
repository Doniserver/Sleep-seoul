"""상세 추정 지도에 쓰는 서울 전역 자료 수집 (공식 API만).

    python -m pipeline.fetch_context      # → data/브이월드/rail.parquet, data/공공데이터포털/상가정보/stores_seoul.parquet

  - 철도시설: 브이월드 2D 데이터 API `LT_C_UPISUQ152`(도시계획시설 교통시설) 중 lcl_nam == "철도"
      속성(실제 응답 확인): dgm_nm(이름), lcl_nam(대분류), mls_nam(중분류: 일반철도·고속철도·도시철도·기타철도시설)
  - 업소: 소상공인시장진흥공단 상가(상권)정보 `storeListInDong` (divId=signguCd, indsLclsCd=I2 음식·I1 숙박·R1 예술·스포츠)
      필드(실제 응답 확인): indsMclsCd(중분류 코드), indsSclsNm(소분류 이름), lon, lat
도로는 pipeline.fetch_roads 로 따로 받는다. 자주 바뀌지 않으므로 필요할 때 손으로 다시 실행한다.
"""
from __future__ import annotations

import json
import os
import time

import numpy as np
import pandas as pd
import requests
import shapely
from dotenv import load_dotenv

from . import config as C
from .fetch_roads import SEOUL, STEP

VW = "https://api.vworld.kr/req/data"
STORE = "https://apis.data.go.kr/B553077/api/open/sdsc2/storeListInDong"
STORE_CLASSES = ("I2", "I1", "R1")


def _get(sess, url, params):
    for a in range(4):
        try:
            return sess.get(url, params=params, timeout=90).json()
        except Exception:
            time.sleep(2 * (a + 1))
    return None


def fetch_rail(sess, key, domain) -> pd.DataFrame:
    rows = {}
    x0, y0, x1, y1 = SEOUL
    for x in np.arange(x0, x1, STEP):
        for y in np.arange(y0, y1, STEP):
            page = 1
            while True:
                j = _get(sess, VW, dict(service="data", request="GetFeature", data="LT_C_UPISUQ152", format="json", size=1000,
                                        page=page, geometry="true", crs="EPSG:4326", domain=domain, key=key,
                                        geomFilter="BOX(%.4f,%.4f,%.4f,%.4f)" % (x, y, x + STEP, y + STEP)))
                r = (j or {}).get("response", {})
                if r.get("status") != "OK":
                    if r.get("status") != "NOT_FOUND":
                        print("  철도시설 요청 실패:", r.get("error"))
                    break
                for f in r["result"]["featureCollection"]["features"]:
                    p = f["properties"]
                    if p.get("lcl_nam") == "철도":
                        rows[f["id"]] = dict(id=f["id"], name=p.get("dgm_nm"), kind=p.get("mls_nam"),
                                             wkt=shapely.to_wkt(shapely.geometry.shape(f["geometry"]), rounding_precision=6))
                if page >= int(r["page"]["total"]):
                    break
                page += 1
    return pd.DataFrame(rows.values())


def fetch_stores(sess, key, gu_codes) -> pd.DataFrame:
    out = []
    for cd in gu_codes:
        for lcls in STORE_CLASSES:
            page = 1
            while True:
                j = _get(sess, STORE, dict(serviceKey=key, divId="signguCd", key=cd, indsLclsCd=lcls, numOfRows=1000, pageNo=page, type="json"))
                code = (j or {}).get("header", {}).get("resultCode")
                if code != "00":
                    if code != "03":   # 03 = 자료 없음
                        print(f"  업소 요청 실패: {cd} {lcls} {page}쪽 ({code})")
                    break
                out += [(x["indsMclsCd"], x["indsSclsNm"], float(x["lon"]), float(x["lat"])) for x in j["body"]["items"] if x.get("lon")]
                if page * 1000 >= int(j["body"]["totalCount"]):
                    break
                page += 1
        print(f"  {cd}: 누적 {len(out):,}곳")
    return pd.DataFrame(out, columns=["mcls", "scls", "lon", "lat"])


def main():
    load_dotenv(C.ROOT / ".env")
    vk = (os.environ.get("VITE_VWORLD_KEY") or "").strip()
    dk = (os.environ.get("DATA_GO_KR_KEY") or "").strip()
    if not vk or not dk:
        raise SystemExit(".env에 VITE_VWORLD_KEY, DATA_GO_KR_KEY가 필요합니다")
    domain = (os.environ.get("VWORLD_DOMAIN") or "localhost:5173").strip()
    sess = requests.Session()
    C.VWORLD.mkdir(parents=True, exist_ok=True); C.SBIZ.mkdir(parents=True, exist_ok=True)
    rail = fetch_rail(sess, vk, domain)
    rail.to_parquet(C.VWORLD / "rail.parquet", index=False)
    print(f"철도시설 {len(rail):,}곳 저장")
    dongs = json.loads((C.WEB_DATA / "dongs_stats.json").read_text(encoding="utf-8"))
    gu_codes = sorted({code[:5] for code in dongs})          # 행정동 코드 앞 5자리 = 시군구 코드
    stores = fetch_stores(sess, dk, gu_codes)
    stores.to_parquet(C.SBIZ / "stores_seoul.parquet", index=False)
    print(f"업소 {len(stores):,}곳 저장")


if __name__ == "__main__":
    main()
