"""센서 → 행정동 집계. 행정동 값 = 동 안 대표 센서들 값의 중앙값 (보간 없음)."""
from __future__ import annotations

import numpy as np
import pandas as pd

from pipeline import config as C
from pipeline import metrics as M


def _emean(s: pd.Series) -> float:
    return float(M.from_energy(s.mean())) if len(s) else float("nan")


def sensor_metrics(night: pd.DataFrame) -> pd.DataFrame:
    """센서별 기간 지표."""
    g = night.groupby("sn")
    out = pd.DataFrame({
        "l_night": g["e"].mean().pipe(M.from_energy),
        "nights": g["nd"].nunique(),
        "peaks": g["nis_max"].apply(lambda x: int((x > C.PEAK_DB).sum())),
        "lux": g["lux_avg"].median(),
    })
    out["peaks_per_night"] = out["peaks"] / out["nights"]
    wk = M.is_weekend_night(night["nd"])
    lw = night[wk].groupby("sn")["e"].mean().pipe(M.from_energy)
    ld = night[~wk].groupby("sn")["e"].mean().pipe(M.from_energy)
    out["weekend_effect"] = (lw - ld).reindex(out.index)
    return out


def choose_basis(sensors: pd.DataFrame) -> pd.DataFrame:
    """동마다 대표 센서 선택: 주거지역 센서가 있으면 그것만, 없으면 공원·도로변을 뺀 나머지."""
    s = sensors[sensors["noise_ok"] & sensors["adm"].notna() & sensors["l_night"].notna()].copy()
    s["basis"] = None
    res = s["rgn"].isin(C.RESIDENTIAL_RGN)
    has_res = s[res].groupby("adm").size()
    s.loc[res, "basis"] = "주거지역 센서"
    other = ~res & ~s["rgn"].isin(C.EXCLUDED_RGN) & ~s["adm"].isin(has_res.index)
    s.loc[other, "basis"] = "비주거 센서(주거지역 센서 없음)"
    return s[s["basis"].notna()]


def _r(x, n=1):
    if x is None:
        return None
    try:
        if np.isnan(x):
            return None
    except TypeError:
        pass
    return round(float(x), n)


def dong_table(night: pd.DataFrame, full: pd.DataFrame, basis: pd.DataFrame, feats) -> dict:
    """행정동별 JSON 레코드."""
    b = basis[["adm", "basis"]]
    nb = night.merge(b, left_on="sn", right_index=True)
    fb = full.merge(b, left_on="sn", right_index=True)

    # 시간대별(밤 슬라이더): 센서별 시간 에너지 평균 → 동 중앙값
    nb["h"] = nb["hs"].dt.hour
    sh = nb.groupby(["adm", "sn", "h"])["e"].mean().pipe(M.from_energy)
    by_hour = sh.groupby(["adm", "h"]).median().unstack()

    # 요일×시간(7×24): 낮 포함. 센서별 에너지 평균 → 동 중앙값
    fb["e"] = M.to_energy(fb["nis_avg"])
    fb["wd"] = fb["hs"].dt.day_of_week
    fb["h"] = fb["hs"].dt.hour
    hm = fb.groupby(["adm", "sn", "wd", "h"])["e"].mean().pipe(M.from_energy).groupby(["adm", "wd", "h"]).median()

    # 밤별(달력): 센서별 밤 L → 동 중앙값
    nl = nb.groupby(["adm", "sn", "nd"])["e"].mean().pipe(M.from_energy).groupby(["adm", "nd"]).median()

    # 월별
    nb["month"] = nb["nd"].dt.strftime("%Y-%m")

    rec = {}
    for f in feats:
        p = f["properties"]
        code = p["adm_cd2"]
        name = p["adm_nm"].split(" ")[-1]
        ss = basis[basis["adm"] == code]
        r = {"code": code, "name": name, "gu": p["sggnm"], "n_sensors": int(len(ss)),
             "basis": ss["basis"].iloc[0] if len(ss) else None, "report": None}
        if len(ss) == 0:
            r["l_night"] = None
            rec[code] = r
            continue
        r["sensors"] = sorted(ss.index.tolist())
        r["l_night"] = _r(ss["l_night"].median())
        r["peaks_per_night"] = _r(ss["peaks_per_night"].median(), 2)
        r["lux"] = _r(ss["lux"].median())
        r["weekend_effect"] = _r(ss["weekend_effect"].median())
        r["score"] = M.sleep_score(r["l_night"], r["lux"] if r["lux"] is not None else float("nan"),
                                   r["peaks_per_night"] if r["peaks_per_night"] is not None else float("nan"))
        if code in by_hour.index:
            r["by_hour"] = {int(h): _r(v) for h, v in by_hour.loc[code].items() if pd.notna(v)}
        if code in hm.index.get_level_values(0):
            m = hm.loc[code].unstack().reindex(index=range(7), columns=range(24))
            r["heatmap"] = [[_r(v) for v in row] for row in m.values]
        if code in nl.index.get_level_values(0):
            cal = nl.loc[code]
            r["nights"] = {d.date().isoformat(): _r(v) for d, v in cal.items()}
            r["quiet_ratio"] = _r((cal < C.QUIET_NIGHT_DB).mean(), 3)
        months = {}
        sub = nb[nb["adm"] == code]
        for mo, part in sub.groupby("month"):
            sm = part.groupby("sn")["e"].mean().pipe(M.from_energy)
            pk = part.groupby("sn").apply(lambda x: (x["nis_max"] > C.PEAK_DB).sum() / x["nd"].nunique(), include_groups=False)
            lx = part.groupby("sn")["lux_avg"].median()
            l = float(sm.median())
            months[mo] = {"l_night": _r(l), "nights": int(part["nd"].nunique()),
                          "score": M.sleep_score(l, float(lx.median()) if lx.notna().any() else float("nan"), float(pk.median()))}
        r["months"] = months
        rec[code] = r
    return rec
