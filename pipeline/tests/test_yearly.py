import pandas as pd
import pytest

from pipeline.yearly import _read_csv_bytes, match_columns

HEADER = ["모델번호", "시리얼", "측정시간", "지역", "자치구", "행정동", "조도 최대(lux)", "조도 평균(lux)", "소음 최대(dB)", "소음 평균(dB)", "등록일시"]


def test_match_columns_finds_by_keyword():
    m = match_columns(HEADER)
    assert m["시리얼"] == "sn" and m["소음 평균(dB)"] == "nis_avg" and m["조도 평균(lux)"] == "lux_avg"


def test_match_columns_missing_raises():
    with pytest.raises(KeyError):
        match_columns(["시리얼", "측정시간"])


def test_read_csv_with_extra_trailing_columns_cp949():
    # 실제 파일처럼 데이터 행이 머리글보다 칸이 많고(cp949), 측정시간에 '_'가 있음
    rows = [",".join(HEADER)]
    rows.append('"SDOT001","S1","2026-10-26_00:07:00","residential_area","Gwanak-gu","X-dong","1","0","60","50","2026-10-26 00:08:00","","",""')
    raw = ("\n".join(rows) + "\n").encode("cp949")
    df = _read_csv_bytes(raw)
    assert len(df) == 1
    r = df.iloc[0]
    assert r["sn"] == "S1" and r["nis_avg"] == 50 and r["nis_max"] == 60 and r["lux_avg"] == 0
    assert r["ts"] == pd.Timestamp("2026-10-26 00:07:00")


def test_read_csv_utf8_bom():
    rows = [",".join(HEADER), 'M,S2,2021-05-01 01:07:00,parks,Jung-gu,Y-dong,5,3,55,45,x']
    raw = ("﻿" + "\n".join(rows) + "\n").encode("utf-8")
    df = _read_csv_bytes(raw)
    assert df.iloc[0]["sn"] == "S2" and df.iloc[0]["ts"] == pd.Timestamp("2021-05-01 01:07:00")


def test_compact_calendar_roundtrip():
    from pipeline.yearly import compact_calendar
    cal = {"A": {"2026-01-01": 40.0, "2026-01-03": 45.5}, "B": {}}
    out = compact_calendar(cal, {"start": "2026-01-01", "end": "2026-01-03"})
    assert out["days"] == 3 and out["dongs"]["A"] == [40.0, None, 45.5] and "B" not in out["dongs"]
