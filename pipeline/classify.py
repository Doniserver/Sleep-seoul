"""소음 패턴 자동 분류: 행정동 7×24 프로필 → 정규화 → k-means.

정규화: 동마다 168칸에서 그 동의 평균을 뺀 값(dB 편차). 크기(얼마나 시끄러운지)가 아니라
'언제 시끄러운지' 모양으로 묶는다. 이름은 군집 중심의 특징을 보고 사람이 정한 규칙(name_cluster)으로 붙인다.
"""
from __future__ import annotations

import numpy as np

from pipeline import config as C
from pipeline import metrics as M

NIGHT = C.NIGHT_START_HOURS
DAY = list(range(9, 19))


def features(center: np.ndarray) -> dict:
    """center: 7×24 dB 편차."""
    c = center.reshape(7, 24)
    night = c[:, NIGHT].mean()
    day = c[:, DAY].mean()
    late = c[:, [22, 23, 0, 1, 2]].mean()
    wk_night = c[[4, 5]][:, NIGHT].mean()       # 금·토 (구간 시작 요일 기준: 금 22시~, 토 22시~ 일부)
    other_night = c[[0, 1, 2, 3, 6]][:, NIGHT].mean()
    return {"day_minus_night": float(day - night), "late_night": float(late),
            "weekend_night_bump": float(wk_night - other_night)}


PATTERN_NAMES = [  # 낮-밤 차이가 큰 순서대로 (사람이 정한 이름)
    ("밤에 조용해지는 주거형", "낮에는 생활 소음이 있지만 밤에는 뚜렷하게 조용해집니다."),
    ("생활 소음형", "낮과 밤의 차이가 중간 정도입니다."),
    ("밤에도 이어지는 소음형", "밤에도 소음이 크게 줄지 않습니다. 큰길·상권·철도 근처에서 흔한 모양입니다."),
]
WEEKEND_NAME = ("주말 밤 활발형", "금·토요일 밤이 다른 밤보다 1dB 이상 시끄럽습니다.")


def name_clusters(clusters: list[dict]) -> None:
    """모양 특징만으로 이름을 붙인다(크기는 쓰지 않음). 주말 밤 상승이 뚜렷한 군집은 따로 이름."""
    rest = []
    for c in clusters:
        if c["features"]["weekend_night_bump"] >= 1.0:
            c["name"], c["desc"] = WEEKEND_NAME
        else:
            rest.append(c)
    rest.sort(key=lambda c: -c["features"]["day_minus_night"])
    for i, c in enumerate(rest):
        idx = 0 if i == 0 else (len(PATTERN_NAMES) - 1 if i == len(rest) - 1 else 1)
        c["name"], c["desc"] = PATTERN_NAMES[idx]
        if sum(1 for o in rest if o.get("name") == c["name"]) > 1:
            c["name"] = f"{c['name']} {i}"


def classify(dongs: dict, k: int = C.N_PATTERNS, seed: int = 42):
    codes, rows = [], []
    for code, r in dongs.items():
        hm = r.get("heatmap")
        if not hm:
            continue
        a = np.array([[np.nan if v is None else v for v in row] for row in hm], dtype=float)
        if np.isnan(a).mean() > 0.1:
            continue
        # 빈 칸은 같은 시간대 다른 요일 평균으로 채움 (분류용으로만)
        col_mean = np.nanmean(a, axis=0)
        a = np.where(np.isnan(a), col_mean[None, :], a)
        rows.append((a - a.mean()).ravel())
        codes.append(code)
    x = np.array(rows)
    labels, centers = M.kmeans(x, k=k, seed=seed)
    clusters = []
    for j in range(k):
        members = [codes[i] for i in range(len(codes)) if labels[i] == j]
        lv = float(np.median([dongs[c]["l_night"] for c in members])) if members else float("nan")
        feat = features(centers[j])
        clusters.append({"id": j, "n": len(members), "level_db": round(lv, 1),
                         "features": {k2: round(v, 2) for k2, v in feat.items()},
                         "profile": [round(float(v), 2) for v in centers[j]]})
    name_clusters(clusters)
    by_id = {c["id"]: c for c in clusters}
    for i, code in enumerate(codes):
        dongs[code]["pattern"] = by_id[int(labels[i])]["name"]
    return clusters
