"""숫자 검증: 화면 JSON의 행정동 값을 집계 코드와 다른 단순한 방법으로 원본 시간별 데이터에서 다시 계산해 비교.

  python -m pipeline.verify            # 무작위 30개 동 + 전체 범위 검사, 불일치 시 종료 코드 1
"""
from __future__ import annotations

import json
import math
import random
import statistics
import sys

import pandas as pd

from pipeline import config as C

TOL = 0.11  # 반올림(0.1) 여유


def emean(vals):
    vals = [v for v in vals if v == v]
    return 10 * math.log10(sum(10 ** (v / 10) for v in vals) / len(vals)) if vals else float("nan")


def main(n=30, seed=0):
    dongs = json.loads((C.WEB_DATA / "dongs_stats.json").read_text(encoding="utf-8"))
    meta = json.loads((C.WEB_DATA / "meta.json").read_text(encoding="utf-8"))
    excluded = json.loads((C.WEB_DATA / "excluded.json").read_text(encoding="utf-8"))
    bad_nights = {(x["sn"], x["night"]) for x in excluded if x["type"] == "night"}

    start = pd.Timestamp(meta["period"]["start"]); end = pd.Timestamp(meta["period"]["end"])
    days = pd.date_range(start, end + pd.Timedelta(days=1)).strftime("%Y-%m-%d")
    files = [C.HOURLY / f"{d}.parquet" for d in days if (C.HOURLY / f"{d}.parquet").exists()]
    raw = pd.concat([pd.read_parquet(f, columns=["sn", "ts", "nis_avg"]) for f in files])

    problems = []
    # 1) 범위 검사
    for code, r in dongs.items():
        L = r.get("l_night")
        if L is None:
            continue
        if not (20 <= L <= 100):
            problems.append(f"{code} l_night 범위 밖 {L}")
        if r.get("score") is not None and not (0 <= r["score"] <= 100):
            problems.append(f"{code} score 범위 밖 {r['score']}")
        if r.get("quiet_ratio") is not None and not (0 <= r["quiet_ratio"] <= 1):
            problems.append(f"{code} quiet_ratio 범위 밖")

    # 2) 표본 재계산 (반복문으로 직접)
    have = [c for c, r in dongs.items() if r.get("l_night") is not None]
    random.Random(seed).shuffle(have)
    checked = 0
    for code in have[:n]:
        r = dongs[code]
        per_sensor = []
        for sn in r["sensors"]:
            rows = raw[raw["sn"] == sn]
            nights: dict[str, list[float]] = {}
            for ts, v in zip(rows["ts"], rows["nis_avg"]):
                if v != v:
                    continue
                hs = ts - pd.Timedelta(hours=1)
                h = hs.hour
                if h not in C.NIGHT_START_HOURS:
                    continue
                nd = (hs.normalize() if h >= 22 else hs.normalize() - pd.Timedelta(days=1)).strftime("%Y-%m-%d")
                if not (meta["period"]["start"] <= nd <= meta["period"]["end"]):
                    continue
                nights.setdefault(nd, []).append(float(v))
            vals = [v for nd, vs in nights.items() if len(vs) >= C.MIN_HOURS_PER_NIGHT and (sn, nd) not in bad_nights for v in vs]
            per_sensor.append(emean(vals))
        L = statistics.median(per_sensor)
        diff = abs(L - r["l_night"])
        checked += 1
        if diff > TOL:
            problems.append(f"{code} {r['gu']} {r['name']}: JSON {r['l_night']} vs 재계산 {L:.2f}")
    print(f"검증: 동 {checked}개 재계산, 범위 검사 {len(have)}개 → 문제 {len(problems)}건")
    for p in problems:
        print("  ✗", p)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
