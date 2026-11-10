"""센서 위치 → 행정동 매칭, 서울 행정동 경계 경량화.

- 설치 위치정보.xlsx(WGS84 좌표)로 점-다각형 포함 판정 → adm_cd2
- 위치 파일에 없는 신규 센서: 같은 (자치구, 영문 행정동) 이름을 가진 매칭 센서들의 행정동을 그대로 사용
  (이름이 여러 행정동에 걸치면 매칭하지 않음)
"""
from __future__ import annotations

import json

import pandas as pd
from shapely import STRtree
from shapely.geometry import Point, mapping, shape

from pipeline import config as C


def load_boundaries():
    g = json.loads(C.BOUNDARY_FILE.read_text(encoding="utf-8"))
    feats = [f for f in g["features"] if f["properties"].get("sidonm") == "서울특별시"]
    return feats


def write_web_boundaries(feats, tolerance=0.00012) -> dict:
    """서울 427개 동 경계를 단순화해 web/public/data/dongs.geojson 으로 저장 (좌표 5자리)."""
    out = []
    for f in feats:
        p = f["properties"]
        geom = shape(f["geometry"]).simplify(tolerance, preserve_topology=True)
        gj = json.loads(json.dumps(mapping(geom)), parse_float=lambda x: round(float(x), 5))
        name = p["adm_nm"].split(" ")[-1]
        out.append({"type": "Feature", "id": int(p["adm_cd2"][:8]),
                    "properties": {"code": p["adm_cd2"], "name": name, "gu": p["sggnm"]},
                    "geometry": gj})
    fc = {"type": "FeatureCollection", "features": out}
    C.WEB_DATA.mkdir(parents=True, exist_ok=True)
    (C.WEB_DATA / "dongs.geojson").write_text(json.dumps(fc, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    return fc


def load_locations() -> pd.DataFrame:
    f = next(C.RAW.glob(C.LOCATION_GLOB))
    loc = pd.read_excel(f, header=0)
    # 머리글: No, 모델 시리얼(*), 주소, 좌표 구분코드, 위도, 경도, 변경 전 시리얼, 변경 전 시리얼(데이터 상 표기)
    loc.columns = ["no", "sn", "addr", "crs", "lat", "lon", "old_sn", "old_sn_data"]
    loc["sn"] = loc["sn"].astype(str).str.strip()
    return loc


def assign_dongs(sensor_meta: pd.DataFrame, feats) -> pd.DataFrame:
    """sensor_meta: index=sn, columns rgn, cgg, dong(영문). 반환: + lat, lon, adm, addr, match."""
    loc = load_locations().drop_duplicates("sn").set_index("sn")
    geoms = [shape(f["geometry"]) for f in feats]
    tree = STRtree(geoms)

    def which(lat, lon):
        idx = tree.query(Point(lon, lat), predicate="within")
        return feats[idx[0]]["properties"]["adm_cd2"] if len(idx) else None

    s = sensor_meta.copy()
    s["lat"] = s.index.map(loc["lat"])
    s["lon"] = s.index.map(loc["lon"])
    s["addr"] = s.index.map(loc["addr"])
    s["adm"] = [which(a, b) if pd.notna(a) else None for a, b in zip(s["lat"], s["lon"])]
    s["match"] = s["adm"].notna().map({True: "좌표", False: None})

    # 이름 기반 보충 매칭
    known = s[s["adm"].notna()].groupby(["cgg", "dong"])["adm"].agg(lambda x: sorted(set(x)))
    for sn in s.index[s["adm"].isna()]:
        key = (s.at[sn, "cgg"], s.at[sn, "dong"])
        if key in known.index and len(known[key]) == 1:
            s.at[sn, "adm"] = known[key][0]
            s.at[sn, "match"] = "동 이름"
    return s
