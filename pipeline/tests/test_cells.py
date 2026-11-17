import math

import pytest

from pipeline import cells as CE


def test_center_of_a_cell_maps_back_to_the_same_cell():
    for q, r in [(0, 0), (3, -2), (-5, 7), (12, 12)]:
        x, y = CE.hex_center(q, r)
        assert CE.hex_of(x, y) == (q, r)


def test_points_well_inside_a_cell_belong_to_it():
    x0, y0 = CE.hex_center(4, -1)
    for ang in range(0, 360, 20):
        x = x0 + 240 * math.cos(math.radians(ang))          # 변까지 거리 250m보다 안쪽
        y = y0 + 240 * math.sin(math.radians(ang))
        assert CE.hex_of(x, y) == (4, -1)


def test_neighbour_centres_are_one_cell_width_apart():
    x0, y0 = CE.hex_center(0, 0)
    for dq, dr in [(1, 0), (0, 1), (-1, 1), (-1, 0), (0, -1), (1, -1)]:
        x, y = CE.hex_center(dq, dr)
        assert math.hypot(x - x0, y - y0) == pytest.approx(CE.HEX_M)


def test_ring_is_closed_and_corners_are_equally_far():
    ring = CE.hex_ring(2, 3)
    assert len(ring) == 7 and ring[0] == ring[-1]
    x0, y0 = CE.hex_center(2, 3)
    for x, y in ring[:6]:
        assert math.hypot(x - x0, y - y0) == pytest.approx(CE.HEX_M / math.sqrt(3))


def test_lonlat_round_trip():
    lon, lat = CE.to_lonlat(*CE.to_xy(127.0276, 37.4979))
    assert lon == pytest.approx(127.0276, abs=1e-9) and lat == pytest.approx(37.4979, abs=1e-9)


def test_xy_distance_matches_ground_distance():
    # 위도 0.001도 ≈ 111.2m
    (x1, y1), (x2, y2) = CE.to_xy(127.0, 37.5), CE.to_xy(127.0, 37.501)
    assert math.hypot(x2 - x1, y2 - y1) == pytest.approx(111.2, abs=0.3)


def test_score_has_three_steps_with_boundaries_on_the_louder_side():
    lo, hi = CE.CUTS
    assert CE.score(lo - 0.1) == 100
    assert CE.score(lo) == 70            # 경계값은 한 단계 시끄러운 쪽
    assert CE.score(hi - 0.1) == 70
    assert CE.score(hi) == 40
    assert CE.score(80) == 40
    assert CE.score(None) is None and CE.score(float("nan")) is None


def test_combine_is_the_median_and_ignores_missing():
    assert CE.combine([50.0, 60.0, 52.0]) == 52.0
    assert CE.combine([50.0, None, float("nan"), 54.0]) == 52.0
    assert CE.combine([None, float("nan")]) is None
    assert CE.combine([]) is None


def test_smaller_cells_use_the_given_width():
    x0, y0 = CE.hex_center(0, 0, 250)
    x1, y1 = CE.hex_center(1, 0, 250)
    assert math.hypot(x1 - x0, y1 - y0) == pytest.approx(250)
    assert CE.hex_of(x1 + 100, y1, 250) == (1, 0)
    assert CE.hex_of(*CE.hex_center(3, -2, 250), 250) == (3, -2)
