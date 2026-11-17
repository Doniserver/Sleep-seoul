import numpy as np
import pytest

from pipeline import roads_shp as RS


def test_origin_of_utmk_is_127_5_east_38_north():
    lon, lat = RS.utmk_to_lonlat(np.array([1_000_000.0]), np.array([2_000_000.0]))
    assert lon[0] == pytest.approx(127.5, abs=1e-9) and lat[0] == pytest.approx(38.0, abs=1e-9)


def test_round_trip_within_a_centimetre_over_seoul():
    lon = np.array([126.76, 126.9784, 127.0276, 127.19])
    lat = np.array([37.41, 37.5665, 37.4979, 37.72])
    x, y = RS.lonlat_to_utmk(lon, lat)
    lon2, lat2 = RS.utmk_to_lonlat(x, y)
    assert np.allclose(lon2, lon, atol=1e-7) and np.allclose(lat2, lat, atol=1e-7)     # 1e-7도 ≈ 1cm


def test_seoul_city_hall_is_where_the_grid_says():
    # 서울시청(126.9784E, 37.5665N)은 기준 경선(127.5E)에서 서쪽으로 약 46km, 기준 위도(38N)에서 남쪽으로 약 48km
    x, y = RS.lonlat_to_utmk(np.array([126.9784]), np.array([37.5665]))
    assert 953_000 < x[0] < 955_000 and 1_951_000 < y[0] < 1_953_000


def test_one_degree_of_latitude_is_about_111km():
    _, y0 = RS.lonlat_to_utmk(np.array([127.5]), np.array([37.0]))
    _, y1 = RS.lonlat_to_utmk(np.array([127.5]), np.array([38.0]))
    assert (y1[0] - y0[0]) == pytest.approx(110_980 * 0.9996, rel=2e-4)


def test_split_parts_cuts_points_at_part_starts():
    pts = np.arange(14, dtype="float64").reshape(7, 2)
    parts = RS.split_parts(pts, [0, 3])
    assert [len(p) for p in parts] == [3, 4] and parts[1][0].tolist() == [6.0, 7.0]
