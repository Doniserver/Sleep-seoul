"""정제·집계 단계 테스트 (작은 합성 데이터)."""
import numpy as np
import pandas as pd
import pytest

from pipeline import aggregate as A
from pipeline import clean as CL
from pipeline import metrics as M


def _make(sn_values: dict, days=5, start="2026-10-05"):
    """sn → 시간마다 같은 dB 값. ts는 측정시간 표기(구간 끝, :07)."""
    rows = []
    hours = pd.date_range(start, periods=24 * days, freq="h") + pd.Timedelta(hours=1, minutes=7)
    for sn, v in sn_values.items():
        for t in hours:
            val = v(t) if callable(v) else v
            rows.append({"sn": sn, "ts": t, "rgn": "residential_area", "cgg": "X-gu", "dong": "Y-dong",
                         "nis_avg": val, "nis_max": val + 3, "lux_avg": 0.0})
    df = pd.DataFrame(rows)
    df["hs"] = M.hour_start(df["ts"])
    df["nd"] = M.night_date(df["hs"])
    return df


def test_clean_drops_stuck_sensor_and_keeps_normal():
    rng = np.random.default_rng(0)
    df = _make({"ok": lambda t: 45 + rng.normal(0, 1), "stuck": 50.0})
    night, full, st, log = CL.clean(df)
    assert bool(st.loc["stuck", "noise_stuck"]) and not bool(st.loc["stuck", "noise_ok"])
    assert set(night["sn"]) == {"ok"}
    assert any(x["sn"] == "stuck" for x in log)


def test_clean_removes_anomalous_night():
    # 10/7 밤(22시~)만 +15dB
    def v(t):
        hs = t - pd.Timedelta(hours=1, minutes=7)
        nd = hs.normalize() if hs.hour >= 22 else hs.normalize() - pd.Timedelta(days=1)
        return 60.0 if nd == pd.Timestamp("2026-10-07") else 45.0 + (hs.hour % 2) * 0.5
    df = _make({"a": v}, days=6)
    night, _, _, log = CL.clean(df)
    assert pd.Timestamp("2026-10-07") not in set(night["nd"])
    assert any(x["type"] == "night" and x["night"] == "2026-10-07" for x in log)


def test_sensor_metrics_energy_and_peaks():
    # 밤 8시간 중 4시간 40dB, 4시간 60dB → 에너지 평균 57.0dB / 피크(최대 > 70) 없음
    def v(t):
        hs = t - pd.Timedelta(hours=1, minutes=7)
        return 40.0 if hs.hour in (22, 23, 0, 1) else 60.0
    df = _make({"a": v}, days=4, start="2026-10-05 12:00")  # 정오 시작 → 온전한 밤 4개
    df.loc[:, "nis_max"] = df["nis_avg"] + 3
    night, _, _, _ = CL.clean(df)
    sm = A.sensor_metrics(night)
    assert sm.loc["a", "l_night"] == pytest.approx(M.energy_mean([40] * 4 + [60] * 4), abs=0.01)
    assert sm.loc["a", "peaks"] == 0


def test_choose_basis_prefers_residential():
    s = pd.DataFrame({
        "noise_ok": [True, True, True, True],
        "adm": ["A", "A", "B", "B"],
        "l_night": [40, 60, 50, 52],
        "rgn": ["residential_area", "main_street", "main_street", "parks"],
    }, index=["s1", "s2", "s3", "s4"])
    b = A.choose_basis(s)
    assert list(b.index) == ["s1", "s3"]   # A동은 주거 센서만, B동은 공원 제외한 비주거
    assert b.loc["s3", "basis"].startswith("비주거")


@pytest.mark.parametrize("adm,bjd", [
    ("역삼1동", "역삼동"), ("상계3·4동", "상계동"), ("면목3·8동", "면목동"),
    ("신당동", "신당동"), ("제기동", "제기동"), ("성내3동", "성내동"), ("신림동", "신림동"),
])
def test_dong_stem(adm, bjd):
    from pipeline.fetch_buildings import stem
    assert stem(adm) == bjd
