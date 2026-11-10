"""전체 빌드: data/hourly → web/public/data/*.json

  python -m pipeline.build            # 최근 365일(있는 만큼)
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import math

import numpy as np
import pandas as pd

from pipeline import aggregate as A
from pipeline import classify as K
from pipeline import clean as CL
from pipeline import config as C
from pipeline import sensors as S


def _json_default(o):
    if isinstance(o, (np.integer,)):
        return int(o)
    if isinstance(o, (np.floating,)):
        return None if math.isnan(o) else float(o)
    if isinstance(o, (pd.Timestamp, dt.date)):
        return o.isoformat()
    raise TypeError(type(o))


def dump(name: str, obj):
    C.WEB_DATA.mkdir(parents=True, exist_ok=True)
    s = json.dumps(obj, ensure_ascii=False, separators=(",", ":"), default=_json_default)
    (C.WEB_DATA / name).write_text(s, encoding="utf-8")
    print(f"  {name}: {len(s) / 1024:.0f} KB")


def run(days: int = 365):
    feats = S.load_boundaries()
    S.write_web_boundaries(feats)
    df = CL.load_hourly(days=days)
    meta_s = CL.sensor_meta(df)
    night, full, st, log = CL.clean(df)
    sm = A.sensor_metrics(night)
    sensors = meta_s.join(st).join(sm)
    sensors = S.assign_dongs(sensors, feats)
    basis = A.choose_basis(sensors)
    dongs = A.dong_table(night, full, basis, feats)
    clusters = K.classify(dongs)

    # 행정동 파일 2개: 지도/리포트용(가벼움) + 달력용(밤별 값)
    calendar = {c: r.pop("nights", {}) for c, r in dongs.items()}
    dump("dongs_stats.json", dongs)
    dump("calendar.json", calendar)
    dump("patterns.json", clusters)

    pts = []
    for sn, r in sensors.iterrows():
        if pd.isna(r.get("lat")):
            continue
        pts.append({"sn": sn, "lat": round(float(r["lat"]), 5), "lon": round(float(r["lon"]), 5),
                    "rgn": r["rgn"], "rgn_ko": C.RGN_KO.get(r["rgn"], r["rgn"]), "adm": r["adm"],
                    "used": bool(sn in basis.index), "noise_ok": bool(r["noise_ok"]),
                    "l_night": A._r(r.get("l_night"))})
    dump("sensors.json", pts)
    dump("excluded.json", log)

    nds = night["nd"].dropna()
    vals = [r["l_night"] for r in dongs.values() if r.get("l_night") is not None]
    meta = {
        "generated_at": dt.datetime.now(dt.timezone(dt.timedelta(hours=9))).isoformat(timespec="minutes"),
        "period": {"start": nds.min().date().isoformat(), "end": nds.max().date().isoformat(),
                   "nights": int(nds.nunique())},
        "months": sorted({m for r in dongs.values() for m in r.get("months", {})}),
        "counts": {"sensors_total": int(len(sensors)), "sensors_noise_ok": int(sensors["noise_ok"].sum()),
                   "sensors_used": int(len(basis)), "dongs_total": len(dongs),
                   "dongs_with_data": len(vals), "excluded_nights": sum(1 for x in log if x["type"] == "night"),
                   "excluded_sensors": sum(1 for x in log if x["type"] == "sensor")},
        "seoul": {"l_night_median": A._r(float(np.median(vals))) if vals else None,
                  "l_night_min": A._r(min(vals)) if vals else None, "l_night_max": A._r(max(vals)) if vals else None},
        "thresholds": {**C.WHO_LINES, "quiet_night": C.QUIET_NIGHT_DB, "peak": C.PEAK_DB, "lux_ref": C.LUX_REF,
                       "noise_floor": C.NOISE_FLOOR_DB, "score_best": C.SCORE_BEST_DB, "score_worst": C.SCORE_WORST_DB},
        "sources": [
            {"name": "서울시 스마트서울 도시데이터 센서(S-DoT) 환경정보", "by": "서울특별시(공공누리 1유형)",
             "url": "https://data.seoul.go.kr/dataList/OA-15969/S/1/datasetView.do"},
            {"name": "행정동 경계 admdongkor ver20261001", "by": "vuski/admdongkor (CC BY 4.0)",
             "url": "https://github.com/vuski/admdongkor"},
        ],
    }
    bfile = C.WEB_DATA / "buildings.json"
    meta["has_buildings"] = bfile.exists()
    if bfile.exists():
        meta["sources"].append({"name": "국토교통부 공동주택 단지 목록·기본 정보(K-APT)", "by": "국토교통부",
                                "url": "https://www.data.go.kr/data/15058453/openapi.do"})
    dump("meta.json", meta)
    return meta


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--days", type=int, default=365)
    a = p.parse_args()
    print(json.dumps(run(a.days), ensure_ascii=False, indent=1))
