import numpy as np
import pytest

from pipeline import heatmap as HM


def test_cuts_are_night_cuts_at_deep_night_and_day_cuts_at_midday():
    night, day = (52.5, 54.5), (57.5, 59.5)
    for h in (23, 0, 1, 2, 3, 4):
        assert HM.hour_cuts(h, night, day) == [52.5, 54.5]
    for h in range(8, 20):
        assert HM.hour_cuts(h, night, day) == [57.5, 59.5]


def test_cuts_move_in_even_steps_through_morning_and_evening():
    night, day = (52.5, 54.5), (57.5, 59.5)
    assert [HM.hour_cuts(h, night, day)[0] for h in (4, 5, 6, 7, 8)] == [52.5, 53.75, 55.0, 56.25, 57.5]
    assert [HM.hour_cuts(h, night, day)[0] for h in (19, 20, 21, 22, 23)] == [57.5, 56.25, 55.0, 53.75, 52.5]
    # 한 시간 사이에 기준이 한 계단(낮·밤 차이의 4분의 1)보다 크게 바뀌지 않는다
    lows = [HM.hour_cuts(h, night, day)[0] for h in range(24)]
    assert max(abs(lows[h] - lows[(h + 1) % 24]) for h in range(24)) == pytest.approx(1.25)


def test_levels_put_boundary_values_on_the_louder_side_and_keep_missing():
    v = np.array([50.0, 52.5, 54.4, 54.5, 70.0, np.nan])
    assert HM.levels(v, [52.5, 54.5]).tolist() == [0, 1, 1, 2, 2, 255]


def test_smooth_keeps_a_flat_surface_flat_and_ignores_outside():
    v = np.full((40, 40), 55.0); m = np.ones((40, 40), bool)
    m[:, :5] = False; v[:, :5] = 999.0                      # 바깥(서울 밖)의 값은 섞이지 않아야 한다
    out = HM.smooth(v, m, 3.0)
    assert np.isnan(out[:, :5]).all()
    assert np.allclose(out[:, 5:], 55.0)


def test_smooth_spreads_a_spike_without_changing_the_total_much():
    v = np.zeros((61, 61)); v[30, 30] = 100.0; m = np.ones((61, 61), bool)
    out = HM.smooth(v, m, 3.0)
    assert out[30, 30] < 10 and out[30, 30] == out.max()     # 뾰족한 값은 낮아지고 가운데가 가장 높다
    assert out.sum() == pytest.approx(100.0, rel=1e-6)
    assert out[30, 33] == pytest.approx(out[33, 30])          # 방향에 따라 다르지 않다


def test_shares_by_label_count_only_cells_that_have_a_level():
    lv = np.array([[0, 0, 1, 2], [0, 255, 2, 2]], dtype="uint8")
    lab = np.array([[1, 1, 1, 1], [2, 2, 2, 0]])               # 0 = 어느 동네도 아님
    out = HM.shares(lv, lab, 3)
    assert out[1] == [0.5, 0.25, 0.25]
    assert out[2] == [0.5, 0.0, 0.5]                           # 값 없는 칸(255)은 세지 않는다
    assert 0 not in out


def test_quiet_score_is_the_share_weighted_score():
    assert HM.quiet_score([1.0, 0.0, 0.0]) == 100
    assert HM.quiet_score([0.0, 0.0, 1.0]) == 40
    assert HM.quiet_score([0.5, 0.3, 0.2]) == pytest.approx(79.0)


def test_means_by_label_ignore_missing_and_unlabelled_cells():
    v = np.array([[50.0, 52.0, np.nan, 60.0], [54.0, 56.0, 58.0, 99.0]])
    lab = np.array([[1, 1, 1, 2], [2, 2, 2, 0]])
    out = HM.means(v, lab)
    assert out[1] == pytest.approx(51.0)                     # nan 은 빼고 평균
    assert out[2] == pytest.approx((60 + 54 + 56 + 58) / 4)
    assert 0 not in out


def test_dong_grade_uses_the_same_cuts_as_the_map():
    assert HM.levels(np.array([52.4, 52.5, 54.5]), HM.NIGHT_CUTS).tolist() == [0, 1, 2]
