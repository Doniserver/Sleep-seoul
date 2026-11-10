import math

import numpy as np
import pandas as pd
import pytest

from pipeline import metrics as m


# ── 에너지 평균 ─────────────────────────────────────────────
def test_energy_mean_equal_values():
    assert m.energy_mean([50, 50, 50]) == pytest.approx(50)


def test_energy_mean_is_louder_than_arithmetic():
    # 40dB와 60dB의 에너지 평균은 산술평균 50이 아니라 57.0dB
    assert m.energy_mean([40, 60]) == pytest.approx(10 * math.log10((1e4 + 1e6) / 2))
    assert m.energy_mean([40, 60]) == pytest.approx(57.03, abs=0.01)


def test_energy_mean_ignores_nan_and_empty():
    assert m.energy_mean([50, np.nan, 50]) == pytest.approx(50)
    assert math.isnan(m.energy_mean([]))
    assert math.isnan(m.energy_mean([np.nan]))


def test_energy_mean_doubling_energy_adds_3db():
    assert m.energy_mean([60, 60, 0 * 0 + 60, 60]) == pytest.approx(60)
    # 두 소리의 합(에너지 평균 아님)은 +3dB
    assert m.energy_sum([60, 60]) == pytest.approx(63.01, abs=0.01)


# ── 측정 시각 → 구간 시작 시각, 밤 날짜 ──────────────────────
def test_hour_start_is_label_minus_one_hour():
    ts = pd.Series(pd.to_datetime(["2026-10-26 00:07", "2026-10-26 23:07"]))
    hs = m.hour_start(ts)
    assert list(hs) == list(pd.to_datetime(["2026-10-25 23:00", "2026-10-26 22:00"]))


def test_night_date_assignment():
    hs = pd.Series(pd.to_datetime([
        "2026-10-25 21:00",  # 밤 아님
        "2026-10-25 22:00",  # 10/25 밤
        "2026-10-25 23:00",  # 10/25 밤
        "2026-10-26 00:00",  # 10/25 밤
        "2026-10-26 05:00",  # 10/25 밤
        "2026-10-26 06:00",  # 밤 아님
    ]))
    nd = m.night_date(hs)
    assert nd.isna().tolist() == [True, False, False, False, False, True]
    assert (nd.dropna() == pd.Timestamp("2026-10-25")).all()


# ── 수면 점수 ──────────────────────────────────────────────
@pytest.mark.parametrize("db,expected", [(35, 100), (40, 100), (52.5, 50), (65, 0), (70, 0)])
def test_noise_score_linear(db, expected):
    assert m.noise_score(db) == pytest.approx(expected)


def test_sleep_score_penalties_and_clamp():
    assert m.sleep_score(40, lux=0, peaks_per_night=0) == 100
    assert m.sleep_score(40, lux=20, peaks_per_night=0) == 95          # 밝기 감점 5
    assert m.sleep_score(40, lux=0, peaks_per_night=1.5) == 97          # 피크 1.5회 × 2
    assert m.sleep_score(40, lux=0, peaks_per_night=30) == 90           # 피크 감점 최대 10
    assert m.sleep_score(66, lux=20, peaks_per_night=30) == 0           # 0 아래로 안 내려감
    assert m.sleep_score(float("nan"), lux=0, peaks_per_night=0) is None
    assert m.sleep_score(40, lux=float("nan"), peaks_per_night=0) == 100  # 조도 없으면 감점 없음


# ── 층간소음 위험 등급 (사용승인일 기준 추정) ──────────────────
@pytest.mark.parametrize("ymd,grade", [
    ("19951231", "높음"), ("20071231", "높음"),
    ("20080101", "보통"), ("20161231", "보통"),
    ("20170101", "낮음"), ("20240630", "낮음"),
    ("20250803", "낮음"),
    ("20250804", "측정 기준 적용"),   # 2022-08-04 사업승인 + 약 3년
])
def test_floor_noise_grade(ymd, grade):
    assert m.floor_noise_grade(ymd) == grade


def test_floor_noise_grade_invalid():
    assert m.floor_noise_grade(None) is None
    assert m.floor_noise_grade("") is None
    assert m.floor_noise_grade("abc") is None


# ── 기타 ───────────────────────────────────────────────────
def test_weekend_flag_uses_night_start_day():
    # 금요일 밤(2026-10-30)과 토요일 밤(10-31)이 주말 밤
    nd = pd.Series(pd.to_datetime(["2026-10-29", "2026-10-30", "2026-10-31", "2026-11-01"]))
    assert m.is_weekend_night(nd).tolist() == [False, True, True, False]


def test_kmeans_separates_obvious_groups():
    rng = np.random.default_rng(0)
    a = rng.normal(0, 0.1, (20, 5))
    b = rng.normal(5, 0.1, (20, 5))
    labels, centers = m.kmeans(np.vstack([a, b]), k=2, seed=1)
    assert len(set(labels[:20])) == 1 and len(set(labels[20:])) == 1
    assert labels[0] != labels[20]
