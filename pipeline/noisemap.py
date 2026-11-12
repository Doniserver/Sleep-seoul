"""상세 추정 소음 지도 (10m 격자).

    python -m pipeline.noisemap [--year 2025]

센서가 없는 자리의 밤 소음을 "주변 조건"으로 추정한다. 측정값이 아니라 추정값이다.
  1) 서울을 10m 칸으로 나누고, 칸마다 주변 조건을 숫자로 만든다
     (반경 안의 도로량 = 차로 수 × 길이, 철도시설 넓이, 음식점·술집·노래방·숙박 수)
  2) 센서 자리의 조건과 센서가 잰 밤 소음(기종 보정 후)으로 모델을 만든다 (pipeline/gbm.py)
  3) 교차검증으로 오차를 재고, 모든 칸에 적용해 한 장의 그림(PNG, 0.25dB 단위)으로 저장한다
입력: data/브이월드/roads.parquet(fetch_roads), rail.parquet, stores_seoul.parquet, 연도별 센서 값
출력: web/public/data/noisemap/night_{연도}.png, noisemap.json
  4) 낮(06~22시) 지도: 센서의 낮 시간 평균 소음을 목표로 같은 방법으로 한 장 더 만든다 (day_{연도}.png)
"""
from __future__ import annotations

import argparse
import json
import struct
import zlib
from dataclasses import dataclass

import numpy as np
import pandas as pd
import shapely

from . import config as C
from . import gbm

R_EARTH = 6378137.0
SEOUL_BBOX = (126.76, 37.41, 127.19, 37.72)
CELL_M = 10.0
DB_MIN, DB_STEP = 30.0, 0.25          # PNG 값 1 = 30dB, 1씩 오를 때마다 0.25dB. 0 = 값 없음
OUT_DIR = C.WEB_DATA / "noisemap"


# ── 격자 (웹 지도와 같은 메르카토르 좌표. 그래야 지도 위에 올렸을 때 어긋나지 않는다) ──
def merc_x(lon):
    return np.radians(np.asarray(lon, dtype="float64")) * R_EARTH


def merc_y(lat):
    return np.log(np.tan(np.pi / 4 + np.radians(np.asarray(lat, dtype="float64")) / 2)) * R_EARTH


def inv_merc_y(y):
    return np.degrees(2 * np.arctan(np.exp(np.asarray(y, dtype="float64") / R_EARTH)) - np.pi / 2)


@dataclass
class Grid:
    x0: float      # 서쪽 끝 (메르카토르)
    y1: float      # 북쪽 끝
    size: float    # 칸 크기 (메르카토르 단위)
    nx: int
    ny: int
    cell_m: float  # 칸 크기 (실제 거리 m, 서울 위도 기준)

    @classmethod
    def from_bbox(cls, min_lon, min_lat, max_lon, max_lat, cell_m=CELL_M):
        k = np.cos(np.radians((min_lat + max_lat) / 2))
        cell = cell_m / k
        x0, x1 = float(merc_x(min_lon)), float(merc_x(max_lon))
        y0, y1 = float(merc_y(min_lat)), float(merc_y(max_lat))
        return cls(x0, y1, cell, int(np.ceil((x1 - x0) / cell)), int(np.ceil((y1 - y0) / cell)), cell_m)

    def cell_f(self, lon, lat):
        return (merc_x(lon) - self.x0) / self.size, (self.y1 - merc_y(lat)) / self.size

    def cell(self, lon, lat):
        c, r = self.cell_f(lon, lat)
        return np.floor(c).astype(int), np.floor(r).astype(int)

    def center(self, col, row):
        x = self.x0 + (np.asarray(col) + 0.5) * self.size
        y = self.y1 - (np.asarray(row) + 0.5) * self.size
        return np.degrees(x / R_EARTH), inv_merc_y(y)

    def bounds(self):
        """(서, 남, 동, 북) 경위도 — 그림의 네 모서리"""
        return (float(np.degrees(self.x0 / R_EARTH)), float(inv_merc_y(self.y1 - self.ny * self.size)),
                float(np.degrees((self.x0 + self.nx * self.size) / R_EARTH)), float(inv_merc_y(self.y1)))


def ground_length(line) -> float:
    """경위도 꺾은선의 실제 길이(m)"""
    a = np.asarray(line, dtype="float64")
    lat = np.radians(a[:, 1]); lon = np.radians(a[:, 0])
    dx = np.diff(lon) * np.cos((lat[:-1] + lat[1:]) / 2); dy = np.diff(lat)
    return float((6371000.0 * np.hypot(dx, dy)).sum())


def rasterize_lines(lines, weights, g: Grid) -> np.ndarray:
    """꺾은선을 칸에 나눠 담는다. 칸 값 = 그 칸을 지나는 길이(m) × 가중치."""
    out = np.zeros((g.ny, g.nx), dtype="float64")
    step = g.cell_m / 2
    cols, rows, vals = [], [], []
    for line, w in zip(lines, weights):
        a = np.asarray(line, dtype="float64")
        if len(a) < 2:
            continue
        lat = np.radians(a[:, 1]); lon = np.radians(a[:, 0])
        seg = 6371000.0 * np.hypot(np.diff(lon) * np.cos((lat[:-1] + lat[1:]) / 2), np.diff(lat))
        n = np.maximum(np.ceil(seg / step).astype(int), 1)
        idx = np.repeat(np.arange(len(seg)), n)
        t = (np.concatenate([np.arange(k) for k in n]) + 0.5) / n[idx]
        px = a[idx, 0] + (a[idx + 1, 0] - a[idx, 0]) * t
        py = a[idx, 1] + (a[idx + 1, 1] - a[idx, 1]) * t
        c, r = g.cell(px, py)
        cols.append(c); rows.append(r); vals.append(w * seg[idx] / n[idx])
    if cols:
        c = np.concatenate(cols); r = np.concatenate(rows); v = np.concatenate(vals)
        ok = (c >= 0) & (c < g.nx) & (r >= 0) & (r < g.ny)
        np.add.at(out, (r[ok], c[ok]), v[ok])
    return out.astype("float32")


def rasterize_points(lon, lat, g: Grid) -> np.ndarray:
    out = np.zeros((g.ny, g.nx), dtype="float64")
    c, r = g.cell(np.asarray(lon), np.asarray(lat))
    ok = (c >= 0) & (c < g.nx) & (r >= 0) & (r < g.ny)
    np.add.at(out, (r[ok], c[ok]), 1.0)
    return out.astype("float32")


def rasterize_polygons(geoms, g: Grid) -> np.ndarray:
    """다각형(경위도) 안에 중심이 들어가는 칸 = 1"""
    out = np.zeros((g.ny, g.nx), dtype="float32")
    for geom in geoms:
        if geom is None or geom.is_empty:
            continue
        w, s, e, n = geom.bounds
        (c0, c1), (r1, r0) = g.cell(np.array([w, e]), np.array([s, n]))
        c0, c1 = max(c0, 0), min(c1, g.nx - 1); r0, r1 = max(r0, 0), min(r1, g.ny - 1)
        if c0 > c1 or r0 > r1:
            continue
        cc, rr = np.meshgrid(np.arange(c0, c1 + 1), np.arange(r0, r1 + 1))
        lon, lat = g.center(cc.ravel(), rr.ravel())
        inside = shapely.contains_xy(geom, lon, lat).reshape(cc.shape)
        out[r0:r1 + 1, c0:c1 + 1][inside] = 1.0
    return out


def rasterize_cover(geoms, g: Grid, sub: int = 2) -> np.ndarray:
    """칸마다 다각형이 덮은 비율(0~1). 칸을 sub×sub 점으로 나눠 센다 (작은 건물도 놓치지 않게)."""
    out = np.zeros((g.ny, g.nx), dtype="float32")
    offs = (np.arange(sub) + 0.5) / sub
    for geom in geoms:
        if geom is None or geom.is_empty:
            continue
        w, s, e, n = geom.bounds
        (c0, c1), (r1, r0) = g.cell(np.array([w, e]), np.array([s, n]))
        c0, c1 = max(c0, 0), min(c1, g.nx - 1); r0, r1 = max(r0, 0), min(r1, g.ny - 1)
        if c0 > c1 or r0 > r1:
            continue
        cols = (np.arange(c0, c1 + 1)[:, None] + offs[None, :]).ravel() - 0.5     # center()가 0.5를 더하므로 미리 뺀다
        rows = (np.arange(r0, r1 + 1)[:, None] + offs[None, :]).ravel() - 0.5
        cc, rr = np.meshgrid(cols, rows)
        lon, lat = g.center(cc.ravel(), rr.ravel())
        inside = shapely.contains_xy(geom, lon, lat).reshape(len(rows), len(cols))
        frac = inside.reshape(r1 - r0 + 1, sub, c1 - c0 + 1, sub).mean(axis=(1, 3))
        np.maximum(out[r0:r1 + 1, c0:c1 + 1], frac, out=out[r0:r1 + 1, c0:c1 + 1])
    return out


def cost_distance(src: np.ndarray, cost: np.ndarray, cell_m: float, max_m: float) -> np.ndarray:
    """출발 칸(src)에서 각 칸까지의 '지나기 어려움을 반영한 거리'(m). cost=1이면 실제 거리,
    건물 칸은 cost를 크게 주어 그 뒤쪽이 더 먼 것으로 계산되게 한다. max_m에서 자른다."""
    d = np.where(src, 0.0, np.float32(max_m)).astype("float32")
    c = cost.astype("float32")
    s2 = np.float32(np.sqrt(2.0))
    moves = [(0, 1, 1.0), (0, -1, 1.0), (1, 0, 1.0), (-1, 0, 1.0), (1, 1, s2), (1, -1, s2), (-1, 1, s2), (-1, -1, s2)]
    H, W = d.shape
    for _ in range(int(4 * max_m / cell_m) + 8):
        before = d.copy()
        for dy, dx, k in moves:
            ys = slice(max(dy, 0), H + min(dy, 0)); yt = slice(max(-dy, 0), H + min(-dy, 0))
            xs = slice(max(dx, 0), W + min(dx, 0)); xt = slice(max(-dx, 0), W + min(-dx, 0))
            step = np.float32(cell_m * k / 2) * (c[ys, xs] + c[yt, xt])          # 두 칸 비용의 평균 × 거리
            np.minimum(d[yt, xt], d[ys, xs] + step, out=d[yt, xt])
        np.minimum(d, np.float32(max_m), out=d)
        if np.array_equal(d, before):
            break
    return d


def disk_sum(a: np.ndarray, r_cells: float) -> np.ndarray:
    """칸마다 반지름 r_cells 안에 있는 값의 합 (가장자리 밖은 0으로 본다)."""
    r = int(np.ceil(r_cells))
    yy, xx = np.mgrid[-r:r + 1, -r:r + 1]
    k = (xx * xx + yy * yy <= r_cells * r_cells).astype("float64")
    H, W = a.shape
    sh = (H + 2 * r, W + 2 * r)
    fa = np.fft.rfft2(a.astype("float64"), sh)
    fk = np.fft.rfft2(k, sh)
    out = np.fft.irfft2(fa * fk, sh)[r:r + H, r:r + W]
    out[np.abs(out) < 1e-6] = 0.0
    return out.astype("float32")


def kernel_sum(a: np.ndarray, rmax_cells: float, power: float = 2.0, dmin_cells: float = 1.0) -> np.ndarray:
    """거리로 약해지는 합: 반경 rmax 안의 값에 (dmin/거리)^power 를 곱해 더한다 (dmin보다 가까우면 1).
    가까운 도로일수록 크게, 멀수록 작게 반영되어 값이 도로에서 멀어질수록 부드럽게 줄어든다."""
    r = int(np.ceil(rmax_cells))
    yy, xx = np.mgrid[-r:r + 1, -r:r + 1]
    d = np.hypot(xx, yy)
    k = np.where(d <= rmax_cells, (dmin_cells / np.maximum(d, dmin_cells)) ** power, 0.0)
    H, W = a.shape
    sh = (H + 2 * r, W + 2 * r)
    out = np.fft.irfft2(np.fft.rfft2(a.astype("float64"), sh) * np.fft.rfft2(k, sh), sh)[r:r + H, r:r + W]
    out[out < 1e-6] = 0.0
    return out.astype("float32")


# ── 값 ↔ 그림 ──
def encode_db(v: np.ndarray) -> np.ndarray:
    b = np.clip(np.round((v - DB_MIN) / DB_STEP) + 1, 1, 255)
    return np.where(np.isnan(v), 0, b).astype(np.uint8)


def decode_db(b: np.ndarray) -> np.ndarray:
    return np.where(b == 0, np.nan, DB_MIN + (b.astype("float64") - 1) * DB_STEP)


def range_db(H: np.ndarray, hours: list[int]) -> np.ndarray:
    """시각별 dB(행 × 시각)에서 고른 시각들의 에너지 평균."""
    return 10 * np.log10(np.mean(10 ** (np.asarray(H, dtype="float64")[:, hours] / 10), axis=1))


def pack_flags(conds: list[np.ndarray]) -> np.ndarray:
    """조건(참/거짓 배열)들을 칸마다 한 바이트로 묶는다. i번째 조건 = 2^i."""
    out = np.zeros(conds[0].shape, dtype=np.uint8)
    for i, c in enumerate(conds):
        out |= (c.astype(np.uint8) << i)
    return out


# 주의 표시: 그 자리 주변에 무엇이 있는지 (센서로 효과를 확인한 조건만. 숫자 근거는 docs/data-check.md 9-2)
# (이름, 바탕 자료, 반경 m, 최소 개수·양, 화면 문구)
FLAGS = [
    ("big_road", "w4", 35, 1e-6, "4차로 이상 큰 도로 35m 안"),
    ("rail", "rail", 50, 1e-6, "철도시설 50m 안"),
    ("food", "food", 50, 10, "음식점 밀집 (50m 안 10곳 이상)"),
    ("bar", "bar", 100, 5, "술집 밀집 (100m 안 5곳 이상)"),
    ("karaoke", "kar", 100, 3, "노래방 밀집 (100m 안 3곳 이상)"),
]


def png_gray(a: np.ndarray) -> bytes:
    """8비트 회색조 PNG (외부 패키지 없이)."""
    h, w = a.shape
    raw = np.concatenate([np.zeros((h, 1), dtype=np.uint8), a.astype(np.uint8)], axis=1).tobytes()

    def chunk(tag: bytes, data: bytes) -> bytes:
        return struct.pack(">I", len(data)) + tag + data + struct.pack(">I", zlib.crc32(tag + data) & 0xFFFFFFFF)

    return (b"\x89PNG\r\n\x1a\n" + chunk(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 0, 0, 0, 0))
            + chunk(b"IDAT", zlib.compress(raw, 9)) + chunk(b"IEND", b""))


# ── 요인 ──
# (이름, 바탕 자료, 반경 m, 거리 지수, 가까운 거리 한계 m, 화면에 보일 설명)
# 값 = 반경 안의 (도로: 차로 수 × 길이 m / 그 외: 개수·넓이)를 거리로 약하게 해서 더한 것
FEATURES = [
    ("road_near", "w2", 300, 2.0, 10, "가까운 도로 (2차로 이상)"), ("road_wide", "w2", 300, 1.0, 10, "주변 도로 전체"),
    ("road4_near", "w4", 300, 2.0, 10, "가까운 큰 도로 (4차로 이상)"), ("road4_wide", "w4", 300, 1.0, 10, "주변 큰 도로"),
    ("road6_near", "w6", 300, 2.0, 10, "가까운 대로 (6차로 이상)"), ("road6_wide", "w6", 300, 1.0, 10, "주변 대로"),
    ("rail", "rail", 200, 1.0, 20, "철도시설"), ("rail_general", "railg", 300, 1.0, 20, "일반·고속철도"),
    ("food", "food", 150, 1.0, 20, "음식점"), ("bar", "bar", 200, 1.0, 20, "술집"),
    ("karaoke", "kar", 200, 1.0, 20, "노래방"), ("lodging", "lodg", 200, 1.0, 20, "숙박업소"),
]
# 건물 가림: 도로에서 그 칸까지 "건물을 지나기 어렵게" 잰 거리. 건물 칸은 (1 + SHIELD_K × 덮인 비율)배 멀게 센다.
# 값 = SHIELD_MAX_M − 그 거리 (클수록 도로에 트여 있음). 센서 검증에서 오차는 거의 같았고(3.38 → 3.36dB),
# 센서가 대부분 길가에 있어 건물 뒤쪽 효과를 직접 확인할 수는 없다 → 물리적으로 타당한 방향만 반영.
SHIELD = [("road_open", "w2", "도로 쪽으로 트인 정도"), ("road4_open", "w4", "큰 도로 쪽으로 트인 정도"), ("road6_open", "w6", "대로 쪽으로 트인 정도")]
SHIELD_K = 20.0
SHIELD_MAX_M = 300.0
MODEL_KW = dict(nq=24, monotone=True)


def base_rasters(g: Grid) -> dict[str, np.ndarray]:
    roads = pd.read_parquet(C.VWORLD / "roads.parquet")
    lines, lanes = [], []
    for ln, js in zip(roads["lanes"], roads["lines"]):
        for line in json.loads(js):
            lines.append(line); lanes.append(float(ln))
    lanes = np.array(lanes)
    pick = lambda m: rasterize_lines([l for l, k in zip(lines, m) if k], lanes[m], g)
    out = {"w2": pick(lanes >= 2), "w4": pick(lanes >= 4), "w6": pick(lanes >= 6)}
    rail = pd.read_parquet(C.VWORLD / "rail.parquet")
    geoms = shapely.from_wkt(rail["wkt"].to_numpy())
    gen = rail["kind"].isin(["일반철도", "고속철도"]).to_numpy()
    out["rail"] = rasterize_polygons(geoms, g)
    out["railg"] = rasterize_polygons(geoms[gen], g)
    st = pd.read_parquet(C.SBIZ / "stores_seoul.parquet")
    m = st["mcls"].astype(str); s = st["scls"].astype(str)
    sel = lambda mask: rasterize_points(st.loc[mask, "lon"], st.loc[mask, "lat"], g)
    out["food"] = sel(m.str.startswith("I2")); out["bar"] = sel(m == "I211")
    out["kar"] = sel(s.str.contains("노래")); out["lodg"] = sel(m.str.startswith("I1"))
    files = sorted((C.VWORLD / "bldg").glob("*.parquet"))
    if files:   # 건물 자료가 있으면 칸마다 건물이 덮은 비율도 만든다 (python -m pipeline.fetch_bldg)
        b = pd.concat([pd.read_parquet(f, columns=["id", "wkb"]) for f in files]).drop_duplicates("id")
        out["cover"] = rasterize_cover(shapely.from_wkb(b["wkb"].to_numpy()), g, sub=2)
    return out


def all_features(base: dict) -> list[tuple]:
    """(이름, 설명, 만드는 방법) 목록. 건물 자료가 없으면 가림 요인은 빠진다."""
    out = [(f[0], f[5], ("kernel", f)) for f in FEATURES]
    if "cover" in base:
        out += [(name, label, ("shield", key)) for name, key, label in SHIELD]
    return out


def make_raster(base: dict, how: tuple, g: Grid) -> np.ndarray:
    if how[0] == "kernel":
        return feature_raster(base, how[1], g)
    src = base[how[1]] > 0
    cost = 1.0 + SHIELD_K * base["cover"]
    cost[src] = 1.0
    return (SHIELD_MAX_M - cost_distance(src, cost, g.cell_m, SHIELD_MAX_M)).astype("float32")


def feature_raster(base: dict, f: tuple, g: Grid) -> np.ndarray:
    _, key, rmax, power, dmin, _ = f
    return kernel_sum(base[key], rmax / g.cell_m, power, dmin / g.cell_m)


def load_sensors(year: int) -> pd.DataFrame:
    s = pd.DataFrame(json.loads((C.WEB_DATA / "years" / f"{year}_sensors.json").read_text(encoding="utf-8")))
    s = s[s["noise_ok"] & s["l_night"].notna() & (s["rgn"] != "parks")]
    return s.set_index("sn")


def sensor_hours(year: int) -> pd.DataFrame:
    """센서별 시각(0~23시)별 소음: 그 해 정제된 시간 자료의 에너지 평균 (기종 보정 후). 동네 값의 '시간대 선택'과 같은 기준."""
    from . import clean as CL
    from . import metrics as M
    df = CL.prepare(pd.read_parquet(C.YEARS_DERIVED / f"{year}.parquet"))
    df = df[df["nd"].isna() | (df["nd"].dt.year == year)]
    df = df[(df["hs"].dt.year == year) | df["nd"].notna()]
    _, full, _, _ = CL.clean(df)
    full = full.assign(e=M.to_energy(full["nis_avg"]), h=full["hs"].dt.hour)
    return full.groupby(["sn", "h"])["e"].mean().pipe(M.from_energy).unstack().reindex(columns=range(24))


DAY_HOURS = list(range(6, 22))      # 낮 = 06~22시 (밤 22~06시의 나머지)


def build_day(year: int, s: pd.DataFrame, X: np.ndarray, feats_def: list, cache_dir, seoul: np.ndarray, g: Grid) -> dict | None:
    """낮(06~22시) 추정 지도 한 장. 목표값 = 센서의 낮 시각별 평균을 에너지 평균한 값."""
    src = C.YEARS_DERIVED / f"{year}.parquet"
    if not src.exists():
        print(f"[noisemap] 낮 지도 건너뜀: {src.name} 없음 (python -m pipeline.yearly 먼저)")
        return None
    sh = sensor_hours(year).reindex(s.index)
    ok = sh[DAY_HOURS].notna().all(axis=1).to_numpy()
    y, Xd = range_db(sh.to_numpy()[ok], DAY_HOURS), X[ok]
    acc = accuracy(gbm.cv_predict(Xd, y, **MODEL_KW), y)
    print(f"[noisemap] 낮 지도 교차검증: 센서 {acc['n']}개, 평균 오차 {acc['mae']}dB (기준선 {acc['baseline_mae']}), ±3dB {acc['within3']:.0%}, ±5dB {acc['within5']:.0%}")
    model = gbm.fit(Xd, y, **MODEL_KW)
    tabs = gbm.tables(model, len(feats_def))
    pred = np.full((g.ny, g.nx), model["base"], dtype="float32")
    for j, (name, _, _) in enumerate(feats_def):
        if len(tabs[j]["thr"]):
            pred += gbm.apply_table(tabs[j], np.load(cache_dir / f"{name}.npy")).astype("float32")
    v = pred[seoul]
    pred[~seoul] = np.nan
    png = png_gray(encode_db(pred))
    (OUT_DIR / f"day_{year}.png").write_bytes(png)
    q = {str(k): round(float(np.quantile(v, k / 100)), 1) for k in (5, 10, 25, 50, 75, 90, 95)}
    print(f"[noisemap] 저장: day_{year}.png {len(png) / 1e6:.1f}MB, 추정값 분포 {q}")
    return {"file": f"day_{year}.png", "hours": [6, 22], "accuracy": acc, "n_sensors": int(ok.sum()), "quantiles": q}


def accuracy(pred: np.ndarray, y: np.ndarray) -> dict:
    e = pred - y
    return {"n": int(len(y)), "mae": round(float(np.abs(e).mean()), 2), "median_abs": round(float(np.median(np.abs(e))), 2),
            "within3": round(float((np.abs(e) <= 3).mean()), 3), "within5": round(float((np.abs(e) <= 5).mean()), 3),
            "baseline_mae": round(float(np.abs(y - np.median(y)).mean()), 2),
            "rank_corr": round(float(pd.Series(pred).rank().corr(pd.Series(y).rank())), 3)}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--year", type=int, default=None)
    ap.add_argument("--no-day", action="store_true", help="낮 지도는 만들지 않음")
    a = ap.parse_args()
    idx = json.loads((C.WEB_DATA / "years" / "index.json").read_text(encoding="utf-8"))
    years = [y["year"] for y in (idx["years"] if isinstance(idx, dict) else idx)]
    year = a.year or max(years)

    g = Grid.from_bbox(*SEOUL_BBOX)
    print(f"[noisemap] 격자 {g.nx}×{g.ny} ({g.cell_m:.0f}m), 기준 연도 {year}")
    base = base_rasters(g)
    s = load_sensors(year)
    col, row = g.cell(s["lon"].to_numpy(), s["lat"].to_numpy())
    inside = (col >= 0) & (col < g.nx) & (row >= 0) & (row < g.ny)
    s, col, row = s[inside], col[inside], row[inside]
    y = s["l_night"].to_numpy(dtype="float64")

    feats_def = all_features(base)
    cache_dir = C.SCRATCH / "noisemap_tmp"
    cache_dir.mkdir(parents=True, exist_ok=True)
    X = np.zeros((len(s), len(feats_def)))
    for j, (name, _, how) in enumerate(feats_def):
        r = make_raster(base, how, g)
        X[:, j] = r[row, col]
        np.save(cache_dir / f"{name}.npy", r.astype("float32"))    # 두 번 계산하지 않도록 잠시 저장
    acc = accuracy(gbm.cv_predict(X, y, **MODEL_KW), y)
    print(f"[noisemap] 교차검증: 센서 {acc['n']}개, 평균 오차 {acc['mae']}dB (기준선 {acc['baseline_mae']}), ±3dB {acc['within3']:.0%}, ±5dB {acc['within5']:.0%}")
    model = gbm.fit(X, y, **MODEL_KW)
    tabs = gbm.tables(model, len(feats_def))

    pred = np.full((g.ny, g.nx), model["base"], dtype="float32")
    for j, (name, _, how) in enumerate(feats_def):
        if len(tabs[j]["thr"]):
            pred += gbm.apply_table(tabs[j], np.load(cache_dir / f"{name}.npy")).astype("float32")
    from . import sensors as SE
    feats = SE.load_boundaries()
    seoul = rasterize_polygons([shapely.geometry.shape(f["geometry"]) for f in feats], g) > 0
    pred[~seoul] = np.nan

    OUT_DIR.mkdir(parents=True, exist_ok=True)
    day = None if a.no_day else build_day(year, s, X, feats_def, cache_dir, seoul, g)
    for f in OUT_DIR.glob("*.png"):          # 다른 해·옛 방식의 그림은 지운다
        if f.name not in (f"night_{year}.png", f"day_{year}.png", "flags.png"):
            f.unlink()
    (OUT_DIR / "hours.json").unlink(missing_ok=True)
    for name, _, _ in feats_def:
        (cache_dir / f"{name}.npy").unlink()
    png = png_gray(encode_db(pred))
    (OUT_DIR / f"night_{year}.png").write_bytes(png)
    flags = pack_flags([disk_sum(base[key], rad / g.cell_m) >= need for _, key, rad, need, _ in FLAGS])
    flags[~seoul] = 0
    fpng = png_gray(flags)
    (OUT_DIR / "flags.png").write_bytes(fpng)
    v = pred[seoul]
    w, s_, e, n = g.bounds()
    meta = {"year": year, "file": f"night_{year}.png", "width": g.nx, "height": g.ny, "cell_m": g.cell_m,
            "bounds": {"west": w, "south": s_, "east": e, "north": n},
            "encoding": {"min_db": DB_MIN, "step_db": DB_STEP, "nodata": 0},
            "accuracy": acc, "n_sensors": int(len(s)),
            "quantiles": {str(q): round(float(np.quantile(v, q / 100)), 1) for q in (5, 10, 25, 50, 75, 90, 95)},
            "base_db": round(model["base"], 2),
            "features": [{"name": f[0], "label": f[1], "thr": [round(t, 3) for t in tabs[j]["thr"]],
                          "add": [round(x, 3) for x in tabs[j]["add"]]} for j, f in enumerate(feats_def)],
            "uses_buildings": "cover" in base, "day": day,
            "flags": {"file": "flags.png", "items": [{"bit": i, "name": f[0], "label": f[4]} for i, f in enumerate(FLAGS)],
                      "share": {f[0]: round(float(((flags[seoul] >> i) & 1).mean()), 3) for i, f in enumerate(FLAGS)}},
            "note": "센서 주변 조건(도로·철도·상가·건물 가림)으로 추정한 밤 소음. 측정값이 아님."}
    (OUT_DIR / "noisemap.json").write_text(json.dumps(meta, ensure_ascii=False, allow_nan=False), encoding="utf-8")
    print(f"[noisemap] 주의 표시 {len(fpng) / 1e6:.1f}MB, 서울에서 차지하는 비율 {meta['flags']['share']}")
    print(f"[noisemap] 저장: night_{year}.png {len(png) / 1e6:.1f}MB, 추정값 분포 {meta['quantiles']}")


if __name__ == "__main__":
    main()
