"""작은 부스팅 모델 (요인 하나를 기준값으로 나누는 규칙을 여러 번 더함).

요인마다 따로 더해지는 꼴이라 "어느 요인이 몇 dB를 올렸는지"를 그대로 읽을 수 있고,
요인별 표로 바꿔 서울 전체 격자에 빠르게 적용할 수 있다. 외부 패키지 없이 numpy만 쓴다.
"""
from __future__ import annotations

import numpy as np


def fit(X: np.ndarray, y: np.ndarray, rounds: int = 300, lr: float = 0.05, nq: int = 10, minleaf: int = 25,
        monotone: bool = False) -> dict:
    """monotone=True 이면 '요인 값이 클수록 결과가 같거나 커지는' 규칙만 쓴다."""
    X = np.asarray(X, dtype="float64"); y = np.asarray(y, dtype="float64")
    n = len(y); base = float(y.mean()); r = y - base
    cand = []
    for j in range(X.shape[1]):
        for t in np.unique(np.quantile(X[:, j], np.linspace(0.04, 0.96, nq))):
            m = X[:, j] <= t
            if minleaf <= m.sum() <= n - minleaf:
                cand.append((j, float(t), m))
    if not cand:
        return {"base": base, "trees": []}
    M = np.array([c[2] for c in cand], dtype="float64"); nl = M.sum(1); nr = n - nl
    trees = []
    for _ in range(rounds):
        sl = M @ r; sr = r.sum() - sl
        gain = sl * sl / nl + sr * sr / nr
        if monotone:
            gain = np.where(sl / nl <= sr / nr, gain, -1.0)
        k = int(gain.argmax())
        if gain[k] < 0:
            break
        a = lr * sl[k] / nl[k]; b = lr * sr[k] / nr[k]
        r = r - np.where(M[k] > 0, a, b)
        trees.append((cand[k][0], cand[k][1], float(a), float(b)))
    return {"base": base, "trees": trees}


def predict(model: dict, X: np.ndarray) -> np.ndarray:
    X = np.asarray(X, dtype="float64")
    p = np.full(len(X), model["base"])
    for j, t, a, b in model["trees"]:
        p += np.where(X[:, j] <= t, a, b)
    return p


def tables(model: dict, ncol: int) -> list[dict]:
    """요인별 (기준값 목록, 구간별 더할 값). 구간 i = 기준값[i-1] < x <= 기준값[i]."""
    out = []
    for j in range(ncol):
        ts = sorted({t for jj, t, _, _ in model["trees"] if jj == j})
        vals = np.zeros(len(ts) + 1)
        for jj, t, a, b in model["trees"]:
            if jj != j:
                continue
            k = ts.index(t)
            vals[: k + 1] += a          # x <= t 인 구간들
            vals[k + 1:] += b
        out.append({"thr": [float(t) for t in ts], "add": [float(v) for v in vals]})
    return out


def apply_table(tab: dict, x: np.ndarray) -> np.ndarray:
    thr = np.asarray(tab["thr"], dtype="float64"); add = np.asarray(tab["add"], dtype="float64")
    return add[np.searchsorted(thr, np.asarray(x, dtype="float64"), side="left")]


def cv_predict(X, y, folds: int = 5, seeds=(0, 1, 2), **kw) -> np.ndarray:
    """교차검증 예측 (여러 번 섞어 평균). 자기 자신을 보고 맞힌 값이 섞이지 않는다."""
    X = np.asarray(X, dtype="float64"); y = np.asarray(y, dtype="float64"); P = np.zeros(len(y))
    for sd in seeds:
        f = np.random.default_rng(sd).permutation(len(y)) % folds
        for k in range(folds):
            tr = f != k
            P[~tr] += predict(fit(X[tr], y[tr], **kw), X[~tr])
    return P / len(seeds)
