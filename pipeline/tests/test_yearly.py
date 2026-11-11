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


OLD_HEADER = ["기관 명", "모델명", "시리얼", "구분", "기온(℃)", "조도(lux)", "소음(dB)", "전송시간", "등록 일자"]


def test_read_old_format_uses_registration_time_and_single_noise():
    rows = [",".join(OLD_HEADER), "서울시,SDOT001,S9,1,14,0,46,2.02E+11,2020.4.1 1:00"]
    df = _read_csv_bytes(("\n".join(rows) + "\n").encode("cp949"))
    r = df.iloc[0]
    assert r["fmt"] == "old" and r["nis_avg"] == 46 and pd.isna(r["nis_max"]) and pd.isna(r["rgn"])
    assert r["ts"] == pd.Timestamp("2020-04-01 01:00")


def test_to_hourly_merges_multiple_records_with_energy_mean():
    import numpy as np
    from pipeline.yearly import to_hourly
    df = pd.DataFrame({"sn": ["A", "A"], "ts": pd.to_datetime(["2023-01-01 01:03:03", "2023-01-01 00:58:00"]),
                       "rgn": ["parks", "parks"], "cgg": ["g", "g"], "dong": ["d", "d"],
                       "nis_avg": [40.0, 60.0], "nis_max": [45.0, 65.0], "lux_avg": [1.0, 3.0], "fmt": ["new", "new"]})
    out = to_hourly(df)
    assert len(out) == 1
    assert out.iloc[0]["ts"] == pd.Timestamp("2023-01-01 01:07")
    assert out.iloc[0]["nis_avg"] == pytest.approx(10 * np.log10((1e4 + 1e6) / 2), abs=0.01)
    assert out.iloc[0]["nis_max"] == 65


@pytest.mark.parametrize("hdr,ts_col", [
    (["기관 명", "시리얼", "조도 (lux)", "소음 (㏈)", "전송시간", "등록 일시"], "등록 일시"),
    (["기관명", "시리얼", "조도 (lux)", "소음 (dB)", "측정시간", "등록 일시"], "등록 일시"),
    (["﻿기관 명", "시리얼", "조도(lux)", "소음(dB)", "전송시간", "등록일자", ""], "등록일자"),
])
def test_old_header_variants(hdr, ts_col):
    from pipeline.yearly import OLD_RULES, _find
    m = _find(hdr, OLD_RULES)
    assert m[ts_col] == "ts" and "sn" in m.values() and "nis_avg" in m.values() and "lux_avg" in m.values()


def test_twelve_hour_measure_time_falls_back_to_registration_time():
    hdr = HEADER[:-1] + ["등록일시"]
    rows = [",".join(hdr),
            'M,S3,2023-01-02_02:07:00,residential_area,G,D,1,0,60,50,2023-01-02 14:07',
            'M,S3,2023-01-02_12:07:00,residential_area,G,D,1,0,60,40,2023-01-02 0:07']
    df = _read_csv_bytes(("\n".join(rows) + "\n").encode("cp949"))
    assert sorted(df["ts"].dt.hour.tolist()) == [0, 14]
