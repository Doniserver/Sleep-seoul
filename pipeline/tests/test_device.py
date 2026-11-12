"""센서 기종 보정 테스트. V02 기종은 OC3 기종·공식 통계보다 낮게 읽으므로 일정한 값을 더한다 (docs/data-check.md 9절)."""
import numpy as np
import pandas as pd
import pytest

from pipeline import clean as CL
from pipeline import config as C
from pipeline import metrics as M


def test_device_offset_by_model_and_year():
    sn = pd.Series(["V02Q1940655", "OC3CL200301", "V02Q1940655", "XX000"])
    ts = pd.Series(pd.to_datetime(["2025-03-01 01:07", "2025-03-01 01:07", "2020-06-01 01:07", "2025-03-01 01:07"]))
    off = M.device_offset(sn, ts)
    assert off[0] == pytest.approx(C.DEVICE_OFFSET_DB["V02"])
    assert off[1] == 0.0                                            # 기준 기종은 그대로
    assert off[2] == pytest.approx(C.DEVICE_OFFSET_BY_YEAR["V02"][2020])   # 2020년은 따로
    assert off[3] == 0.0                                            # 모르는 기종은 건드리지 않음


def test_device_offset_uses_hour_start_year_at_new_year():
    # 2021-01-01 00:07 표기는 2020-12-31 23시 구간 → 2020년 보정값
    off = M.device_offset(pd.Series(["V02Q1"]), pd.Series(pd.to_datetime(["2021-01-01 00:07"])))
    assert off[0] == pytest.approx(C.DEVICE_OFFSET_BY_YEAR["V02"][2020])


def test_prepare_applies_offset_once_and_keeps_missing():
    df = pd.DataFrame({
        "sn": ["V02Q1", "OC3CL1", "V02Q1", "V02Q1"],
        "ts": pd.to_datetime(["2025-05-01 02:07", "2025-05-01 02:07", "2025-05-01 03:07", "2025-05-01 04:07"]),
        "rgn": "residential_area", "cgg": "X", "dong": "Y",
        "nis_avg": [44.0, 53.0, np.nan, 10.0],        # 10dB는 범위 밖 → 결측
        "nis_max": [47.0, 56.0, 50.0, 12.0],
        "lux_avg": 0.0,
    })
    out = CL.prepare(df)
    d = C.DEVICE_OFFSET_DB["V02"]
    assert out["nis_avg"].iloc[0] == pytest.approx(44.0 + d) and out["nis_max"].iloc[0] == pytest.approx(47.0 + d)
    assert out["nis_avg"].iloc[1] == pytest.approx(53.0)
    assert np.isnan(out["nis_avg"].iloc[2]) and out["nis_max"].iloc[2] == pytest.approx(50.0 + d)
    assert np.isnan(out["nis_avg"].iloc[3])                          # 범위 밖 값은 보정 뒤에도 결측
    again = CL.prepare(out)                                          # 두 번 불러도 두 번 더하지 않는다
    assert again["nis_avg"].iloc[0] == pytest.approx(44.0 + d)
    assert df["nis_avg"].iloc[0] == 44.0                             # 원본은 그대로
