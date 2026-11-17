"""도로 중심선: 브이월드 '공간정보 다운로드'에서 받은 SHP 파일을 읽어 서울의 2차로 이상 도로만 뽑는다.

    python -m pipeline.roads_shp        # → data/브이월드_다운로드/roads.parquet

왜 이 파일을 쓰나: 같은 자료(국토지리정보원 연속수치지형도 도로중심선)를 API로 받아 저장하면 브이월드 약관에 어긋나지만,
다운로드 서비스의 파일은 표시된 라이선스(CC BY / 공공데이터포털 15146878 공공누리 1유형, 출처 표시)를 따르므로 상업적으로 쓸 수 있다.
받는 곳: https://www.vworld.kr/dtmk/dtmk_ntads_s002.do?dsId=30182&svcCde=MK (로그인 필요, 사람이 직접 받는다)

확인한 것 (실제 파일 N3L_A0020000_001, 2026-11-18):
  - 좌표계: Korea 2000 Unified CS = EPSG:5179 (가로 메르카토르, 기준 127.5E·38N, 축척 0.9996, 가산 1,000,000·2,000,000, GRS80)
  - 도형: 꺾은선(PolyLine, 종류 3). 속성(DBF): UFID, RDNU, NAME, RDDV, STPT, EDPT, PVQT, DVYN, RDLN(차로 수), RVWD(도로 폭 m), ONSD, REST, RDNM, SCLS, FMTA
  - 파일은 200만 건씩 나뉘어 있고, 서울 범위의 선은 001 파일 안에 이어서 들어 있다
외부 도형 라이브러리 없이 numpy로 읽는다.
"""
from __future__ import annotations

import json
import struct
from pathlib import Path

import numpy as np
import pandas as pd

from . import config as C

SRC_DIR = C.DATA / "브이월드_다운로드" / "도로중심선"
OUT = C.DATA / "브이월드_다운로드" / "roads.parquet"
SEOUL = (126.76, 37.41, 127.19, 37.72)   # minLon, minLat, maxLon, maxLat
MIN_LANES = 2

# EPSG:5179
_A, _F = 6378137.0, 1 / 298.257222101
_LAT0, _LON0, _K0, _FE, _FN = 38.0, 127.5, 0.9996, 1_000_000.0, 2_000_000.0
_E2 = 2 * _F - _F * _F
_EP2 = _E2 / (1 - _E2)


def _m(phi):
    e2 = _E2
    return _A * ((1 - e2 / 4 - 3 * e2**2 / 64 - 5 * e2**3 / 256) * phi - (3 * e2 / 8 + 3 * e2**2 / 32 + 45 * e2**3 / 1024) * np.sin(2 * phi)
                 + (15 * e2**2 / 256 + 45 * e2**3 / 1024) * np.sin(4 * phi) - (35 * e2**3 / 3072) * np.sin(6 * phi))


def lonlat_to_utmk(lon, lat):
    phi = np.radians(np.asarray(lon, dtype="float64") * 0 + np.asarray(lat, dtype="float64")); lam = np.radians(np.asarray(lon, dtype="float64") - _LON0)
    n = _A / np.sqrt(1 - _E2 * np.sin(phi) ** 2); t = np.tan(phi) ** 2; c = _EP2 * np.cos(phi) ** 2; a = lam * np.cos(phi)
    x = _FE + _K0 * n * (a + (1 - t + c) * a**3 / 6 + (5 - 18 * t + t * t + 72 * c - 58 * _EP2) * a**5 / 120)
    y = _FN + _K0 * (_m(phi) - _m(np.radians(_LAT0)) + n * np.tan(phi) * (a * a / 2 + (5 - t + 9 * c + 4 * c * c) * a**4 / 24
                                                                         + (61 - 58 * t + t * t + 600 * c - 330 * _EP2) * a**6 / 720))
    return x, y


def utmk_to_lonlat(x, y):
    x = np.asarray(x, dtype="float64"); y = np.asarray(y, dtype="float64")
    m1 = _m(np.radians(_LAT0)) + (y - _FN) / _K0
    mu = m1 / (_A * (1 - _E2 / 4 - 3 * _E2**2 / 64 - 5 * _E2**3 / 256)); e1 = (1 - np.sqrt(1 - _E2)) / (1 + np.sqrt(1 - _E2))
    p1 = (mu + (3 * e1 / 2 - 27 * e1**3 / 32) * np.sin(2 * mu) + (21 * e1**2 / 16 - 55 * e1**4 / 32) * np.sin(4 * mu)
          + (151 * e1**3 / 96) * np.sin(6 * mu) + (1097 * e1**4 / 512) * np.sin(8 * mu))
    c1 = _EP2 * np.cos(p1) ** 2; t1 = np.tan(p1) ** 2; n1 = _A / np.sqrt(1 - _E2 * np.sin(p1) ** 2)
    r1 = _A * (1 - _E2) / (1 - _E2 * np.sin(p1) ** 2) ** 1.5; d = (x - _FE) / (n1 * _K0)
    lat = p1 - (n1 * np.tan(p1) / r1) * (d**2 / 2 - (5 + 3 * t1 + 10 * c1 - 4 * c1**2 - 9 * _EP2) * d**4 / 24
                                         + (61 + 90 * t1 + 298 * c1 + 45 * t1**2 - 252 * _EP2 - 3 * c1**2) * d**6 / 720)
    lon = np.radians(_LON0) + (d - (1 + 2 * t1 + c1) * d**3 / 6 + (5 - 2 * c1 + 28 * t1 - 3 * c1**2 + 8 * _EP2 + 24 * t1**2) * d**5 / 120) / np.cos(p1)
    return np.degrees(lon), np.degrees(lat)


def split_parts(points: np.ndarray, starts) -> list[np.ndarray]:
    """점 배열을 조각 시작 번호에서 잘라 조각별 배열로."""
    starts = list(starts) + [len(points)]
    return [points[a:b] for a, b in zip(starts[:-1], starts[1:])]


def _dbf_layout(path: Path):
    with open(path, "rb") as f:
        h = f.read(32); n, hl, rl = struct.unpack("<IHH", h[4:12])
        fields, off = {}, 1
        while True:
            b = f.read(32)
            if b[0] == 0x0D:
                break
            name = b[:11].split(b"\x00")[0].decode("ascii"); fields[name] = (off, b[16]); off += b[16]
    return n, hl, rl, fields


def _text(raw: bytes) -> str:
    for enc in ("utf-8", "cp949"):
        try:
            return raw.decode(enc).strip()
        except UnicodeDecodeError:
            pass
    return raw.decode("cp949", "replace").strip()


def read_seoul(stem: Path, bbox=SEOUL, min_lanes: int = MIN_LANES) -> pd.DataFrame:
    """SHP 한 벌(.shp/.shx/.dbf)에서 서울 범위에 걸친 min_lanes 차로 이상 도로를 읽는다."""
    xs, ys = lonlat_to_utmk(np.array([bbox[0], bbox[0], bbox[2], bbox[2]]), np.array([bbox[1], bbox[3], bbox[1], bbox[3]]))
    x0, x1, y0, y1 = xs.min(), xs.max(), ys.min(), ys.max()
    off = np.fromfile(stem.with_suffix(".shx"), dtype=">i4", offset=100).reshape(-1, 2)[:, 0].astype(np.int64) * 2
    shp = np.memmap(stem.with_suffix(".shp"), dtype="uint8", mode="r")
    hit = np.zeros(len(off), dtype=bool)
    for i in range(0, len(off), 200_000):                      # 선마다 적혀 있는 범위(상자)로 먼저 거른다
        o = off[i:i + 200_000] + 12
        bb = shp[o[:, None] + np.arange(32)[None, :]].copy().view("<f8").reshape(-1, 4)
        hit[i:i + 200_000] = (bb[:, 2] >= x0) & (bb[:, 0] <= x1) & (bb[:, 3] >= y0) & (bb[:, 1] <= y1)
    n, hl, rl, fields = _dbf_layout(stem.with_suffix(".dbf"))
    assert n == len(off), "도형 수와 속성 수가 다르다"
    dbf = np.memmap(stem.with_suffix(".dbf"), dtype="uint8", mode="r", offset=hl)
    lo, ln = fields["RDLN"]
    rows = []
    for i in np.nonzero(hit)[0]:
        rec = bytes(dbf[i * rl:(i + 1) * rl])
        try:
            lanes = int(float(rec[lo:lo + ln].decode("ascii").strip() or 0))
        except ValueError:
            lanes = 0
        if lanes < min_lanes:
            continue
        o = int(off[i]) + 8
        assert struct.unpack("<i", bytes(shp[o:o + 4]))[0] == 3, "꺾은선이 아닌 도형"
        nparts, npts = struct.unpack("<ii", bytes(shp[o + 36:o + 44]))
        starts = np.frombuffer(bytes(shp[o + 44:o + 44 + 4 * nparts]), dtype="<i4")
        p0 = o + 44 + 4 * nparts
        pts = np.frombuffer(bytes(shp[p0:p0 + 16 * npts]), dtype="<f8").reshape(-1, 2)
        lon, lat = utmk_to_lonlat(pts[:, 0], pts[:, 1])
        ll = np.column_stack([np.round(lon, 6), np.round(lat, 6)])
        get = lambda k: _text(rec[fields[k][0]:fields[k][0] + fields[k][1]])
        try:
            width = float(get("RVWD") or "nan")
        except ValueError:
            width = float("nan")
        rows.append({"ufid": get("UFID"), "name": get("NAME"), "lanes": lanes, "width": width, "rddv": get("RDDV"),
                     "lines": json.dumps([p.tolist() for p in split_parts(ll, starts)], separators=(",", ":"))})
    return pd.DataFrame(rows)


def run():
    stems = sorted(p.with_suffix("") for p in SRC_DIR.glob("*.shp"))
    if not stems:
        raise SystemExit(f"{SRC_DIR} 에 도로중심선 SHP 파일이 없습니다. 파일 맨 위 설명의 주소에서 받아 풀어 넣으세요.")
    df = pd.concat([read_seoul(s) for s in stems], ignore_index=True).drop_duplicates("ufid")
    df.to_parquet(OUT, index=False)
    print(f"[roads_shp] 서울 범위 {MIN_LANES}차로 이상 {len(df)}개 → {OUT.relative_to(C.ROOT)} (차로 수별: {df['lanes'].value_counts().sort_index().to_dict()})")
    return df


if __name__ == "__main__":
    run()
