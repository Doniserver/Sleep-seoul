"""소음 히트맵: 서울 전체를 세 단계(조용·보통·시끄러움) 구역으로 → web/public/data/heat/

    python -m pipeline.heatmap [--year 2025]

만드는 것 (밤 평균, 낮 평균, 0~23시 = 26장)
  heat_{이름}.png    화면에 그리는 그림 (조용 = 투명, 보통 = 옅은 주황, 시끄러움 = 빨강)
  heatlv_{이름}.png  자리별 단계를 꺼내 읽는 그림 (빨강 값 = (단계+1)×80, 0 = 값 없음)
  heat.json          범위·크기·기준값·정확도
  dongs.json         동네별 [조용·보통·시끄러움 자리의 비율, 평균 dB] (동네별 보기용. 동네의 단계 = 평균 dB를 같은 기준으로 나눈 것)

계산 순서
  1. 센서 자리마다 주변 조건을 센다: 도로(차로 수 × 길이, 2·4·6차로 이상)와 상가(음식점·술집·노래방·숙박).
  2. 센서가 잰 값과 그 조건 사이의 관계를 찾는다(gbm, 조건이 클수록 값이 같거나 커지는 규칙만).
  3. 그 관계를 서울 전체 10m 칸에 적용하고, 주변 약 150m를 부드럽게 묶은 뒤 30m 간격으로 줄인다.
  4. 기준값으로 세 단계로 나눈다. 한밤(23~04시)은 밤 기준, 한낮(08~19시)은 낮 기준, 그 사이 시각은 둘 사이를 고르게 나눈 값.

쓰는 자료 (모두 출처 표시 조건으로 상업적 이용 가능, data/README.md 참고)
  - 서울 열린데이터광장 S-DoT 센서, 브이월드 공간정보 다운로드의 도로중심선, 공공데이터포털 상가(상권)정보.
  - 철도·건물 자료는 쓰지 않는다 (빼도 정확도가 같았다: 평균 오차 3.36 → 3.38dB).
"""
from __future__ import annotations

import argparse
import json
import struct
import zlib

import numpy as np
import pandas as pd
import shapely

from pipeline import config as C
from pipeline import gbm
from pipeline import noisemap as NM
from pipeline import sensors as SE

OUT = C.WEB_DATA / "heat"
SIGMA_M = 150.0                    # 묶는 범위
STEP = 3                           # 10m 칸을 3칸마다 하나로 (30m)
NIGHT_CUTS = (52.5, 54.5)          # dB. 밤 평균 지도에서 조용 65%·보통 27%·시끄러움 8%쯤 되는 값 (잠정)
DAYNESS = {5: 0.25, 6: 0.5, 7: 0.75, 20: 0.75, 21: 0.5, 22: 0.25}     # 그 시각의 기준이 낮 기준에 얼마나 가까운가 (없으면 08~19시 = 1, 나머지 = 0)
SCORES = (100, 70, 40)
PALETTE = ((255, 255, 255), (247, 178, 92), (214, 62, 48))
ALPHA = (0, 255, 255)              # 조용한 곳은 칠하지 않는다
FEATURES = [f for f in NM.FEATURES if not f[0].startswith("rail")]


def hour_cuts(h: int, night, day) -> list[float]:
    d = DAYNESS.get(h, 1.0 if 8 <= h <= 19 else 0.0)
    return [round(n + (dd - n) * d, 2) for n, dd in zip(night, day)]


def levels(v: np.ndarray, cuts) -> np.ndarray:
    """0 조용, 1 보통, 2 시끄러움, 255 값 없음. 경계값은 시끄러운 쪽."""
    out = np.digitize(np.nan_to_num(v, nan=-1e9), list(cuts)).astype("uint8")
    out[np.isnan(v)] = 255
    return out


def _box(a: np.ndarray, r: int) -> np.ndarray:
    c = np.cumsum(np.pad(a, ((0, 0), (r + 1, r))), axis=1); a = c[:, 2 * r + 1:] - c[:, :-2 * r - 1]
    c = np.cumsum(np.pad(a, ((r + 1, r), (0, 0))), axis=0); return c[2 * r + 1:] - c[:-2 * r - 1]


def smooth(v: np.ndarray, mask: np.ndarray, sigma_px: float) -> np.ndarray:
    """mask 안의 값만으로 부드럽게 묶는다(상자 흐림 3번 ≈ 가우스 흐림). mask 밖은 nan."""
    a = np.where(mask, v, 0.0).astype("float64"); w = mask.astype("float64")
    r = max(1, int(round(sigma_px * 0.87)))
    for _ in range(3):
        a = _box(a, r); w = _box(w, r)
    out = np.where(w > 1e-9, a / np.maximum(w, 1e-9), np.nan)
    out[~mask] = np.nan
    return out


def shares(lv: np.ndarray, labels: np.ndarray, n_levels: int) -> dict[int, list[float]]:
    """labels(0 = 해당 없음)별로 단계 0..n-1이 차지하는 비율."""
    ok = (labels > 0) & (lv < n_levels)
    cnt = np.zeros((int(labels.max()) + 1, n_levels))
    np.add.at(cnt, (labels[ok], lv[ok]), 1)
    tot = cnt.sum(1)
    return {int(k): [round(float(x), 4) for x in cnt[k] / tot[k]] for k in np.nonzero(tot)[0]}


def means(v: np.ndarray, labels: np.ndarray) -> dict[int, float]:
    """labels(0 = 해당 없음)별 평균. 값이 없는 칸(nan)은 뺀다."""
    ok = (labels > 0) & ~np.isnan(v)
    n = int(labels.max()) + 1
    tot = np.bincount(labels[ok], weights=v[ok], minlength=n); cnt = np.bincount(labels[ok], minlength=n)
    return {int(k): float(tot[k] / cnt[k]) for k in np.nonzero(cnt)[0] if k > 0}


def quiet_score(share) -> float:
    return float(sum(s * p for s, p in zip(SCORES, share)))


def png_rgba(a: np.ndarray) -> bytes:
    h, w, _ = a.shape
    raw = b"".join(b"\x00" + a[i].tobytes() for i in range(h))
    ch = lambda t, d: struct.pack(">I", len(d)) + t + d + struct.pack(">I", zlib.crc32(t + d) & 0xFFFFFFFF)
    return b"\x89PNG\r\n\x1a\n" + ch(b"IHDR", struct.pack(">IIBBBBB", w, h, 8, 6, 0, 0, 0)) + ch(b"IDAT", zlib.compress(raw, 9)) + ch(b"IEND", b"")


def base_rasters(g: NM.Grid) -> dict[str, np.ndarray]:
    roads = pd.read_parquet(C.roads_file())
    lines, lanes = [], []
    for ln, js in zip(roads["lanes"], roads["lines"]):
        for line in json.loads(js):
            if len(line) >= 2:
                lines.append(line); lanes.append(float(ln))
    lanes = np.array(lanes)
    pick = lambda m: NM.rasterize_lines([l for l, k in zip(lines, m) if k], lanes[m], g)
    out = {"w2": pick(lanes >= 2), "w4": pick(lanes >= 4), "w6": pick(lanes >= 6)}
    st = pd.read_parquet(C.SBIZ / "stores_seoul.parquet")
    m = st["mcls"].astype(str); s = st["scls"].astype(str)
    sel = lambda mask: NM.rasterize_points(st.loc[mask, "lon"], st.loc[mask, "lat"], g)
    out["food"] = sel(m.str.startswith("I2")); out["bar"] = sel(m == "I211")
    out["kar"] = sel(s.str.contains("노래")); out["lodg"] = sel(m.str.startswith("I1"))
    return out


def run(year: int) -> dict:
    g = NM.Grid.from_bbox(*NM.SEOUL_BBOX)
    base = base_rasters(g)
    s = NM.load_sensors(year)
    H = NM.sensor_hours(year).reindex(s.index)
    ok = H.notna().all(axis=1).to_numpy()
    s, H = s[ok], H[ok].to_numpy(float)
    col, row = g.cell(s["lon"].to_numpy(), s["lat"].to_numpy())
    rasters, X = [], np.zeros((len(s), len(FEATURES)))
    for j, f in enumerate(FEATURES):
        r = NM.feature_raster(base, f, g).astype("float32"); rasters.append(r); X[:, j] = r[row, col]
    feats = SE.load_boundaries()
    geoms = [shapely.geometry.shape(f["geometry"]) for f in feats]
    seoul = NM.rasterize_polygons(geoms, g) > 0
    # 동네 번호 그림 (30m): 동네별 비율을 낼 때 쓴다. 도로가 300m 안에 없는 칸(산·강 한가운데)은 세지 않는다
    labels = np.zeros((g.ny, g.nx), dtype="int32")
    for k, geom in enumerate(geoms, start=1):
        labels[NM.rasterize_polygons([geom], g) > 0] = k
    urban = rasters[[f[0] for f in FEATURES].index("road_wide")] > 0
    labels = np.where(urban, labels, 0)[::STEP, ::STEP]
    codes = {k: f["properties"]["adm_cd2"] for k, f in enumerate(feats, start=1)}

    def predict(y):
        acc = NM.accuracy(gbm.cv_predict(X, y, **NM.MODEL_KW), y)
        model = gbm.fit(X, y, **NM.MODEL_KW); tabs = gbm.tables(model, len(FEATURES))
        pred = np.full((g.ny, g.nx), model["base"], dtype="float32")
        for j in range(len(FEATURES)):
            if len(tabs[j]["thr"]):
                pred += gbm.apply_table(tabs[j], rasters[j]).astype("float32")
        return smooth(pred, seoul, SIGMA_M / g.cell_m)[::STEP, ::STEP], acc

    targets = {"night": s["l_night"].to_numpy(float), "day": NM.range_db(H, NM.DAY_HOURS)}
    targets.update({f"h{h}": H[:, h] for h in range(24)})
    vals, accs = {}, {}
    for key, y in targets.items():
        vals[key], accs[key] = predict(y)
    shift = round(float(np.nanmedian(vals["day"]) - np.nanmedian(vals["night"])))      # 낮은 서울 전체가 이만큼 더 시끄럽다
    day_cuts = tuple(c + shift for c in NIGHT_CUTS)
    cuts = {"night": list(NIGHT_CUTS), "day": list(day_cuts), **{f"h{h}": hour_cuts(h, NIGHT_CUTS, day_cuts) for h in range(24)}}

    OUT.mkdir(parents=True, exist_ok=True)
    for f in OUT.glob("*"):
        f.unlink()
    pal = np.array(PALETTE, dtype="uint8"); alpha = np.array(ALPHA, dtype="uint8")
    frames, dongs, size = {}, {}, 0
    for key in targets:
        lv = levels(vals[key], cuts[key]); m = lv < 255
        img = np.zeros(lv.shape + (4,), dtype="uint8"); img[m, :3] = pal[lv[m]]; img[m, 3] = alpha[lv[m]]
        lvimg = np.zeros(lv.shape + (4,), dtype="uint8"); lvimg[..., 3] = 255; lvimg[m, 0] = (lv[m] + 1) * 80
        for name, a in ((f"heat_{key}.png", img), (f"heatlv_{key}.png", lvimg)):
            b = png_rgba(a); (OUT / name).write_bytes(b); size += len(b)
        frames[key] = {"file": f"heat_{key}.png", "cuts": cuts[key], "mae": accs[key]["mae"],
                       "share": [round(float((lv[m] == k).mean()), 3) for k in range(3)]}
        mean = means(vals[key], labels)
        # 동네별: [조용, 보통, 시끄러움 비율, 평균 dB]. 동네의 단계는 평균 dB를 지도와 같은 기준으로 나눈 것
        dongs[key] = {codes[k]: v + [round(mean[k], 1)] for k, v in shares(lv, labels, 3).items() if k in mean}
    w, so, e, n = g.bounds()
    info = {"year": year, "bounds": {"west": w, "south": so, "east": e, "north": n}, "width": int(lv.shape[1]), "height": int(lv.shape[0]),
            "cell_m": g.cell_m * STEP, "sigma_m": SIGMA_M, "n_sensors": int(len(s)), "scores": list(SCORES),
            "colors": ["#%02x%02x%02x" % c for c in PALETTE], "day_shift_db": shift, "frames": frames,
            "features": [f[5] for f in FEATURES],
            "note": "센서가 잰 값과 주변 도로·상가의 관계로 계산한 추정. 집 안 소음이 아님."}
    dump = lambda name, o: (OUT / name).write_text(json.dumps(o, ensure_ascii=False, separators=(",", ":"), allow_nan=False), encoding="utf-8")
    dump("heat.json", info); dump("dongs.json", dongs)
    mae = np.mean([a["mae"] for a in accs.values()])
    print(f"[heatmap] {year}: 센서 {len(s)}개, 그림 {len(targets)}장 × 2 = {size / 1e6:.1f}MB, 평균 오차 {mae:.2f}dB, 낮·밤 차이 {shift}dB")
    print(f"[heatmap] 밤 평균 지도 넓이(조용/보통/시끄러움) {frames['night']['share']}, 동네 {len(dongs['night'])}곳")
    return info


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--year", type=int, default=None)
    a = ap.parse_args()
    idx = json.loads((C.WEB_DATA / "years" / "index.json").read_text(encoding="utf-8"))
    run(a.year or max(y["year"] for y in idx))
