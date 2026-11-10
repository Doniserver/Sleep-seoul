"""숫자 처리 함수 (순수 함수만). 테스트: pipeline/tests/test_metrics.py"""
from __future__ import annotations

import math
from typing import Iterable

import numpy as np
import pandas as pd

from pipeline import config as C


def _clean(values: Iterable[float]) -> np.ndarray:
    a = np.asarray(list(values) if not isinstance(values, (np.ndarray, pd.Series)) else values, dtype=float)
    return a[~np.isnan(a)]


def energy_mean(values: Iterable[float]) -> float:
    """dB 값들의 에너지 평균: 10·log10(mean(10^(L/10)))."""
    a = _clean(values)
    if a.size == 0:
        return float("nan")
    return float(10 * np.log10(np.mean(np.power(10.0, a / 10.0))))


def energy_sum(values: Iterable[float]) -> float:
    """dB 값들의 에너지 합 (여러 소리가 동시에 날 때)."""
    a = _clean(values)
    if a.size == 0:
        return float("nan")
    return float(10 * np.log10(np.sum(np.power(10.0, a / 10.0))))


def to_energy(db: pd.Series | np.ndarray) -> np.ndarray:
    return np.power(10.0, np.asarray(db, dtype=float) / 10.0)


def from_energy(e: pd.Series | np.ndarray | float):
    return 10 * np.log10(e)


def hour_start(ts: pd.Series) -> pd.Series:
    """측정시간 표기(구간 끝, 예: 07:07) → 1시간 구간의 시작 정각(06:00)."""
    return (ts - pd.Timedelta(hours=1)).dt.floor("h")


def night_date(hs: pd.Series) -> pd.Series:
    """구간 시작 시각 → 그 시간이 속한 '밤'의 날짜(22시가 시작된 날). 밤이 아니면 NaT."""
    h = hs.dt.hour
    nd = hs.dt.normalize().where(h >= 22, hs.dt.normalize() - pd.Timedelta(days=1))
    return nd.where(h.isin(C.NIGHT_START_HOURS))


def is_weekend_night(nd: pd.Series) -> pd.Series:
    """금요일 밤·토요일 밤 = 주말 밤 (다음 날 쉬는 밤)."""
    return nd.dt.day_of_week.isin([4, 5])


def noise_score(db: float) -> float:
    if db is None or (isinstance(db, float) and math.isnan(db)):
        return float("nan")
    if db <= C.SCORE_BEST_DB:
        return 100.0
    if db >= C.SCORE_WORST_DB:
        return 0.0
    return 100.0 * (C.SCORE_WORST_DB - db) / (C.SCORE_WORST_DB - C.SCORE_BEST_DB)


def sleep_score(l_night: float, lux: float, peaks_per_night: float) -> int | None:
    """수면 점수 0~100 (잠정 산식, docs/methodology.md)."""
    if l_night is None or math.isnan(l_night):
        return None
    s = noise_score(l_night)
    if lux is not None and not math.isnan(lux) and lux > C.LUX_REF:
        s -= C.SCORE_LUX_PENALTY
    if peaks_per_night is not None and not math.isnan(peaks_per_night):
        s -= min(C.SCORE_PEAK_PENALTY_MAX, C.SCORE_PEAK_PENALTY_PER * peaks_per_night)
    return int(round(max(0.0, min(100.0, s))))


def floor_noise_grade(use_approval_ymd: str | None) -> str | None:
    """사용승인일(YYYYMMDD) → 층간소음 위험 '추정' 등급.

    사업승인 기준 제도를 사용승인일로 근사(2~3년 시차). 기준은 CLAUDE.md 6절.
    """
    if not use_approval_ymd:
        return None
    s = str(use_approval_ymd).strip().replace("-", "")
    if len(s) < 8 or not s[:8].isdigit():
        return None
    ymd = int(s[:8])
    if ymd >= 20250804:
        return "측정 기준 적용"
    year = ymd // 10000
    if year <= 2007:
        return "높음"
    if year <= 2016:
        return "보통"
    return "낮음"


def kmeans(x: np.ndarray, k: int, seed: int = 0, iters: int = 200, n_init: int = 10):
    """k-means++ 초기화 + Lloyd 반복. 여러 번 시작해 관성(inertia)이 가장 작은 결과를 고른다."""
    rng = np.random.default_rng(seed)
    best = None
    for _ in range(n_init):
        centers = [x[rng.integers(len(x))]]
        for _ in range(1, k):
            d2 = np.min(((x[:, None, :] - np.array(centers)[None]) ** 2).sum(-1), axis=1)
            p = d2 / d2.sum() if d2.sum() > 0 else None
            centers.append(x[rng.choice(len(x), p=p)])
        c = np.array(centers, dtype=float)
        for _ in range(iters):
            lab = np.argmin(((x[:, None, :] - c[None]) ** 2).sum(-1), axis=1)
            new = np.array([x[lab == j].mean(0) if np.any(lab == j) else c[j] for j in range(k)])
            if np.allclose(new, c):
                break
            c = new
        inertia = ((x - c[lab]) ** 2).sum()
        if best is None or inertia < best[0]:
            best = (inertia, lab, c)
    return best[1], best[2]
