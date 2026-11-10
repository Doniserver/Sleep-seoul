"""정제: 기간 로드, 센서 상태 판정(고장·결측), 이상치 밤 제거. 제외 내역은 모두 기록한다."""
from __future__ import annotations

import datetime as dt

import numpy as np
import pandas as pd

from pipeline import config as C
from pipeline import metrics as M


def load_hourly(days: int = 365, end: dt.date | None = None) -> pd.DataFrame:
    files = sorted(C.HOURLY.glob("*.parquet"))
    if not files:
        raise SystemExit("data/hourly 가 비어 있습니다. 먼저 python -m pipeline.fetch_sdot 실행")
    last = end or dt.date.fromisoformat(files[-1].stem)
    first = last - dt.timedelta(days=days - 1)
    use = [f for f in files if first <= dt.date.fromisoformat(f.stem) <= last]
    df = pd.concat([pd.read_parquet(f) for f in use], ignore_index=True)
    for c in ["rgn", "cgg", "dong"]:
        df[c] = df[c].astype("string")
    df["hs"] = M.hour_start(df["ts"])
    df["nd"] = M.night_date(df["hs"])
    # 측정 하한 미만·범위 밖 값 정리 (명세 범위 밖 숫자는 결측 처리)
    df.loc[(df["nis_avg"] < 20) | (df["nis_avg"] > 130), "nis_avg"] = np.nan
    df.loc[(df["nis_max"] < 20) | (df["nis_max"] > 140), "nis_max"] = np.nan
    df.loc[df["lux_avg"] < 0, "lux_avg"] = np.nan
    return df


def sensor_meta(df: pd.DataFrame) -> pd.DataFrame:
    last = df.sort_values("ts").groupby("sn").tail(1).set_index("sn")
    return last[["rgn", "cgg", "dong"]]


def clean(df: pd.DataFrame):
    """반환: (밤 데이터, 전체 데이터(낮 포함, 고장 센서 제외), 센서 상태표, 제외 기록 list)"""
    log: list[dict] = []
    nights_all = pd.date_range(df["nd"].min(), df["nd"].max(), freq="D")
    n_night_hours = df.loc[df["nd"].notna(), "hs"].nunique()  # 데이터 기간 안의 실제 밤 시간 수

    st = pd.DataFrame(index=sorted(df["sn"].unique()))
    # 1) 소음 값이 기간 내내 변하지 않는 센서 = 고장 의심
    sd = df.groupby("sn")["nis_avg"].agg(["std", "count"])
    st["noise_stuck"] = (sd["count"] > 0) & (sd["std"].fillna(0) == 0)
    # 2) 밤 시간 결측률
    night = df[df["nd"].notna()]
    have = night.dropna(subset=["nis_avg"]).groupby("sn").size()
    st["night_missing"] = (1 - have.reindex(st.index).fillna(0) / n_night_hours).clip(0, 1).round(3)
    # 3) 조도 이상 (밤 조도 중앙값이 비정상적으로 큼)
    lux_med = night.groupby("sn")["lux_avg"].median()
    st["lux_night_median"] = lux_med.reindex(st.index)
    st["lux_broken"] = st["lux_night_median"] > C.LUX_BROKEN

    st["noise_ok"] = ~st["noise_stuck"] & (st["night_missing"] <= C.MAX_NIGHT_MISSING)
    for sn, r in st.iterrows():
        if r["noise_stuck"]:
            log.append({"type": "sensor", "sn": sn, "reason": "소음 값 변화 없음(고장 의심)"})
        elif r["night_missing"] > C.MAX_NIGHT_MISSING:
            log.append({"type": "sensor", "sn": sn, "reason": f"밤 결측률 {r['night_missing']:.0%}"})
        if r["lux_broken"]:
            log.append({"type": "sensor_lux", "sn": sn, "reason": f"밤 조도 중앙값 {r['lux_night_median']:.0f} lux(조도 이상)"})

    ok = st.index[st["noise_ok"]]
    night = night[night["sn"].isin(ok)].dropna(subset=["nis_avg"]).copy()
    night.loc[night["sn"].isin(st.index[st["lux_broken"]]), "lux_avg"] = np.nan

    # 4) 유효한 밤(8시간 중 6시간 이상)만 사용
    cnt = night.groupby(["sn", "nd"])["nis_avg"].transform("size")
    night = night[cnt >= C.MIN_HOURS_PER_NIGHT].copy()

    # 5) 이상치 밤: 센서의 밤 L 중앙값보다 ANOMALY_DB 이상 높은 밤 (공사·축제·일시 고장 등)
    night["e"] = M.to_energy(night["nis_avg"])
    nl = night.groupby(["sn", "nd"])["e"].mean().pipe(M.from_energy).rename("L").reset_index()
    med = nl.groupby("sn")["L"].transform("median")
    bad = nl[nl["L"] > med + C.ANOMALY_DB]
    for _, r in bad.iterrows():
        log.append({"type": "night", "sn": r["sn"], "night": r["nd"].date().isoformat(),
                    "reason": f"평소보다 {r['L'] - med[_]:.1f}dB 높음", "L": round(float(r["L"]), 1)})
    key = set(zip(bad["sn"], bad["nd"]))
    if key:
        mask = [(a, b) in key for a, b in zip(night["sn"], night["nd"])]
        night = night[~np.array(mask)]

    full = df[df["sn"].isin(ok)].dropna(subset=["nis_avg"]).copy()
    if key:
        mask = [(a, b) in key for a, b in zip(full["sn"], full["nd"])]
        full = full[~np.array(mask)]
    return night, full, st, log
