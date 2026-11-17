"""500m 육각형 칸별 0~23시 소음 → web/public/data/years/{연도}_cells.json

- 서울을 마주 보는 변 사이가 500m인 육각형 칸으로 나눈다(넓이 약 0.22㎢, 행정동 평균의 6분의 1쯤).
- 칸 값 = 그 칸 안에 있는 센서들의 시각별 값(한 해 평균)의 가운데 값. 센서가 없는 칸은 만들지 않는다(주변 값으로 채우지 않음).
- 점수는 세 단계: CUTS[0] 미만 = 100(조용), CUTS[1] 미만 = 70(보통), 그 이상 = 40(시끄러움).

실행: python -m pipeline.cells [--year 2025]
"""
from __future__ import annotations

import argparse
import json
import math

import numpy as np

from pipeline import config as C

HEX_M = 500.0                 # 칸 크기: 마주 보는 변 사이 거리(m)
CUTS = (51.0, 57.0)           # dB. 0~100점 산식(45dB=100, 65dB=0)에서 70점·40점에 해당
SCORES = (100, 70, 40)
LON0, LAT0 = 126.99, 37.55    # 평면으로 펼 때의 기준점(서울 한가운데쯤)
R_EARTH = 6371000.0


def to_xy(lon: float, lat: float) -> tuple[float, float]:
    """경위도 → 기준점에서의 동쪽·북쪽 거리(m). 서울 크기에서는 오차가 수 m 이내."""
    return (R_EARTH * math.radians(lon - LON0) * math.cos(math.radians(LAT0)), R_EARTH * math.radians(lat - LAT0))


def to_lonlat(x: float, y: float) -> tuple[float, float]:
    return (LON0 + math.degrees(x / (R_EARTH * math.cos(math.radians(LAT0)))), LAT0 + math.degrees(y / R_EARTH))


def hex_center(q: int, r: int, d: float = HEX_M) -> tuple[float, float]:
    s = d / math.sqrt(3)             # 가운데에서 꼭짓점까지
    return (s * math.sqrt(3) * (q + r / 2), s * 1.5 * r)


def hex_of(x: float, y: float, d: float = HEX_M) -> tuple[int, int]:
    """그 자리가 속한 칸 번호 (q, r). 꼭짓점이 위를 향한 육각형. d = 마주 보는 변 사이 거리."""
    s_ = d / math.sqrt(3)
    fq = (math.sqrt(3) / 3 * x - y / 3) / s_
    fr = (2 / 3 * y) / s_
    fs = -fq - fr
    q, r, s = round(fq), round(fr), round(fs)
    dq, dr, ds = abs(q - fq), abs(r - fr), abs(s - fs)
    if dq > dr and dq > ds:
        q = -r - s
    elif dr > ds:
        r = -q - s
    return int(q), int(r)


def ring_around(x0: float, y0: float, d: float = HEX_M) -> list[tuple[float, float]]:
    """(x0, y0)를 가운데로 하는 육각형의 꼭짓점 6개 + 처음 점(닫힌 고리), 평면 좌표(m)."""
    s = d / math.sqrt(3)
    pts = [(x0 + s * math.cos(math.radians(30 + 60 * k)), y0 + s * math.sin(math.radians(30 + 60 * k))) for k in range(6)]
    return pts + [pts[0]]


def hex_ring(q: int, r: int, d: float = HEX_M) -> list[tuple[float, float]]:
    return ring_around(*hex_center(q, r, d), d)


def score(db, cuts: tuple[float, float] = CUTS) -> int | None:
    if db is None or (isinstance(db, float) and math.isnan(db)):
        return None
    return SCORES[0] if db < cuts[0] else SCORES[1] if db < cuts[1] else SCORES[2]


def combine(values) -> float | None:
    """칸 안 센서 값들의 가운데 값. 빈 값은 뺀다."""
    v = [float(x) for x in values if x is not None and not math.isnan(float(x))]
    return float(np.median(v)) if v else None


def load_hours(year: int):
    """(센서 표, 센서×24시 값). 쓸 수 있는 센서(공원 제외, 기종 보정 뒤) 가운데 하루 24시각이 모두 있는 것만."""
    from pipeline import noisemap as NM     # 센서 목록·시각별 값은 같은 기준을 쓴다
    s = NM.load_sensors(year)
    H = NM.sensor_hours(year).reindex(s.index)
    ok = H.notna().all(axis=1)
    return s[ok], H[ok]


def build(year: int, hex_m: float = HEX_M, data=None) -> dict:
    s, H = data if data is not None else load_hours(year)
    groups: dict[tuple[int, int], list[str]] = {}
    for sn, lon, lat in zip(s.index, s["lon"], s["lat"]):
        groups.setdefault(hex_of(*to_xy(lon, lat), hex_m), []).append(sn)
    cells = []
    for (q, r), sns in sorted(groups.items()):
        h = [combine(H.loc[sns, k]) for k in range(24)]
        lon, lat = to_lonlat(*hex_center(q, r, hex_m))
        cells.append({"id": f"{q}_{r}", "lon": round(lon, 5), "lat": round(lat, 5), "n": len(sns),
                      "ring": [[round(a, 5), round(b, 5)] for a, b in (to_lonlat(x, y) for x, y in hex_ring(q, r, hex_m))],
                      "h": [round(v, 1) for v in h]})
    return {"year": year, "hex_m": hex_m, "cuts": list(CUTS), "scores": list(SCORES), "n_sensors": int(sum(c["n"] for c in cells)),
            "note": "칸 값 = 칸 안 센서들의 시각별 값(한 해 평균)의 가운데 값. 센서가 없는 칸은 없음(채우지 않음).", "cells": cells}


def build_points(year: int, size_m: float = 120.0, data=None) -> dict:
    """센서마다 그 자리에 작은 육각형 하나 (칸으로 묶지 않음)."""
    s, H = data if data is not None else load_hours(year)
    cells = []
    for sn, lon, lat in zip(s.index, s["lon"], s["lat"]):
        x, y = to_xy(lon, lat)
        cells.append({"id": sn, "lon": round(lon, 5), "lat": round(lat, 5), "n": 1,
                      "ring": [[round(a, 5), round(b, 5)] for a, b in (to_lonlat(u, v) for u, v in ring_around(x, y, size_m))],
                      "h": [round(float(v), 1) for v in H.loc[sn]]})
    return {"year": year, "hex_m": size_m, "cuts": list(CUTS), "scores": list(SCORES), "n_sensors": len(cells),
            "note": "센서 한 곳 = 표시 하나. 그 자리에서 잰 값 그대로.", "cells": cells}


def write(year: int) -> dict:
    out = build(year)
    path = C.WEB_DATA / "years" / f"{year}_cells.json"
    path.write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":"), allow_nan=False), encoding="utf-8")
    n1 = sum(1 for c in out["cells"] if c["n"] == 1)
    print(f"[cells] {year}: 칸 {len(out['cells'])}개(센서 {out['n_sensors']}개, 센서 1개뿐인 칸 {n1}개), {path.stat().st_size / 1e3:.0f}KB → {path.name}")
    return out


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--year", type=int, default=None)
    a = ap.parse_args()
    idx = json.loads((C.WEB_DATA / "years" / "index.json").read_text(encoding="utf-8"))
    write(a.year or max(y["year"] for y in idx))
