"""상세 추정 지도: 격자·선 그리기·반경 합·모델·PNG 쓰기 테스트."""
import struct
import zlib

import numpy as np
import pytest

from pipeline import gbm
from pipeline import noisemap as N


def small_grid():
    return N.Grid.from_bbox(126.90, 37.50, 126.92, 37.515, cell_m=10.0)


def test_grid_cell_size_and_roundtrip():
    g = small_grid()
    # 경도 0.02도 ≈ 1.77km, 위도 0.015도 ≈ 1.66km → 10m 칸으로 약 177 × 167
    assert 170 <= g.nx <= 184 and 160 <= g.ny <= 174
    col, row = g.cell(np.array([126.91]), np.array([37.5075]))
    lon, lat = g.center(col, row)
    assert abs(lon[0] - 126.91) < 0.0001 and abs(lat[0] - 37.5075) < 0.0001
    # 맨 위 줄이 북쪽
    assert g.cell(np.array([126.91]), np.array([37.5149]))[1][0] < g.cell(np.array([126.91]), np.array([37.5001]))[1][0]


def test_rasterize_line_keeps_total_length_times_weight():
    g = small_grid()
    line = np.array([[126.905, 37.505], [126.915, 37.505]])       # 동서로 약 883m
    r = N.rasterize_lines([line], [4.0], g)
    length = N.ground_length(line)
    assert 870 < length < 895
    assert r.sum() == pytest.approx(4.0 * length, rel=0.02)
    assert (r > 0).sum() >= 85                                     # 10m 칸 85개 이상에 걸침


def test_disk_sum_of_single_cell_is_a_disk():
    a = np.zeros((41, 41), dtype="float32"); a[20, 20] = 2.0
    s = N.disk_sum(a, 3)                                           # 반지름 3칸
    assert s[20, 20] == pytest.approx(2.0) and s[20, 23] == pytest.approx(2.0) and s[23, 20] == pytest.approx(2.0)
    assert s[20, 24] == pytest.approx(0.0, abs=1e-4) and s[23, 23] == pytest.approx(0.0, abs=1e-4)
    assert s.sum() == pytest.approx(2.0 * 29, rel=1e-4)            # 반지름 3인 원 안의 칸 29개
    assert s[0, 0] == pytest.approx(0.0, abs=1e-4)                 # 가장자리로 넘어 돌아오지 않음


def test_kernel_sum_decays_with_distance():
    a = np.zeros((61, 61), dtype="float32"); a[30, 30] = 100.0
    s = N.kernel_sum(a, 20, power=2.0, dmin_cells=1.0)
    assert s[30, 30] == pytest.approx(100.0) and s[30, 31] == pytest.approx(100.0)
    assert s[30, 40] == pytest.approx(100.0 / 10 ** 2, rel=1e-3)      # 10칸 떨어지면 1/100
    assert s[30, 51] == pytest.approx(0.0, abs=1e-4)                   # 반경 밖
    assert s[30, 34] > s[30, 38] > s[30, 45] > 0                       # 멀수록 작아짐


def test_gbm_monotone_never_decreases():
    rng = np.random.default_rng(1)
    X = rng.uniform(0, 10, size=(500, 1))
    y = 50 + X[:, 0] + rng.normal(0, 2.0, 500)
    m = gbm.fit(X, y, rounds=200, nq=20, monotone=True)
    p = gbm.predict(m, np.linspace(0, 10, 200)[:, None])
    assert (np.diff(p) >= -1e-9).all() and p[-1] - p[0] > 6


def test_gbm_learns_a_step_and_tables_match_predict():
    rng = np.random.default_rng(0)
    X = rng.uniform(0, 100, size=(400, 2))
    y = 50 + np.where(X[:, 0] > 60, 6.0, 0.0) + rng.normal(0, 0.3, 400)
    m = gbm.fit(X, y, rounds=200)
    p = gbm.predict(m, np.array([[80.0, 10.0], [20.0, 90.0]]))
    assert p[0] == pytest.approx(56, abs=0.6) and p[1] == pytest.approx(50, abs=0.6)
    # 요인별 표로 바꿔 계산해도 같은 값 (격자 전체를 빠르게 계산할 때 씀)
    tabs = gbm.tables(m, 2)
    q = m["base"] + sum(gbm.apply_table(tabs[j], X[:, j]) for j in range(2))
    assert np.allclose(q, gbm.predict(m, X), atol=1e-6)


def test_encode_db_and_png():
    v = np.array([[np.nan, 30.0], [52.3, 120.0]])
    b = N.encode_db(v)
    assert b.dtype == np.uint8 and b[0, 0] == 0 and b[0, 1] == 1 and b[1, 1] == 255
    assert N.decode_db(b)[1, 0] == pytest.approx(52.3, abs=0.13)   # 0.25dB 단위
    png = N.png_gray(b)
    assert png[:8] == b"\x89PNG\r\n\x1a\n"
    w, h, depth, ctype = struct.unpack(">IIBB", png[16:26])
    assert (w, h, depth, ctype) == (2, 2, 8, 0)
    i = png.index(b"IDAT"); n = struct.unpack(">I", png[i - 4:i])[0]
    raw = zlib.decompress(png[i + 4:i + 4 + n])
    assert raw == bytes([0, 0, 1, 0, b[1, 0], 255])                # 줄마다 필터 바이트 0


def test_rasterize_cover_gives_fraction_of_cell_covered():
    import shapely
    g = small_grid()
    c0, r0 = 50, 60
    (w, e), (n, s) = g.center(np.array([c0, c0 + 3]), np.array([r0, r0 + 3]))
    half = (g.center(np.array([1]), np.array([0]))[0][0] - g.center(np.array([0]), np.array([0]))[0][0]) / 2
    # 칸 (50~53) × (60~63)을 덮되, 동쪽 끝 칸은 절반만 덮는 사각형
    poly = shapely.box(w - half, s - 0.00004, e, n + 0.00004)
    cov = N.rasterize_cover([poly], g, sub=4)
    assert cov[r0 + 1, c0 + 1] == pytest.approx(1.0)
    assert cov[r0 + 1, c0 + 3] == pytest.approx(0.5, abs=0.13)
    assert cov[r0 + 1, c0 + 5] == 0.0 and cov[r0 - 3, c0 + 1] == 0.0


def test_cost_distance_open_ground_and_behind_a_wall():
    src = np.zeros((40, 60), dtype=bool); src[:, 5] = True              # 세로로 긴 도로
    open_cost = np.ones((40, 60), dtype="float32")
    d = N.cost_distance(src, open_cost, cell_m=10.0, max_m=600)
    assert d[20, 5] == 0 and d[20, 15] == pytest.approx(100.0) and d[20, 45] == pytest.approx(400.0)
    # 도로와 나란한 건물 벽(통과 비용 10배)을 세우면, 벽 뒤는 실제 거리보다 훨씬 멀게 계산된다
    cost = open_cost.copy(); cost[5:35, 20:22] = 10.0
    w = N.cost_distance(src, cost, cell_m=10.0, max_m=600)
    assert w[20, 15] == pytest.approx(100.0)                              # 벽 앞은 그대로
    assert w[20, 30] > d[20, 30] + 80                                     # 벽 뒤는 멀어짐 (250m → 돌아가는 길 약 347m)
    assert w[20, 30] < 430                                                # 벽을 뚫는 값(약 430m)보다 돌아가는 쪽이 짧다
    assert w[1, 30] == pytest.approx(d[1, 30], abs=30)                    # 벽이 없는 줄은 거의 그대로
    far = N.cost_distance(src, open_cost, cell_m=10.0, max_m=200)
    assert far[20, 45] == pytest.approx(200.0)                            # 한도에서 자름


def test_pack_flags_sets_one_bit_per_condition():
    a = np.array([[True, False], [True, True]]); b = np.array([[False, False], [True, False]]); c = np.array([[False, True], [True, False]])
    f = N.pack_flags([a, b, c])
    assert f.dtype == np.uint8
    assert f.tolist() == [[1, 4], [7, 1]]            # 첫 조건 = 1, 둘째 = 2, 셋째 = 4


# ---- 낮 지도: 시각별 값의 에너지 평균 ----

def test_range_db_is_energy_mean_of_hours():
    H = np.array([[40.0, 60.0, 50.0], [50.0, 50.0, 50.0]])
    out = N.range_db(H, [0, 1])
    assert out[0] == pytest.approx(10 * np.log10((1e4 + 1e6) / 2), abs=1e-6)
    assert out[1] == pytest.approx(50.0)
