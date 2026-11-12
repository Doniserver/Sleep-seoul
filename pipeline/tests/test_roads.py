"""도로 중심선 수집: 응답 한 줄 해석과 서울을 칸으로 나누는 부분 테스트 (네트워크 없이)."""
import json

from pipeline import fetch_roads as R


def test_parse_feature_reads_lanes_width_and_lines():
    f = {"geometry": {"type": "MultiLineString", "coordinates": [[[126.9706404, 37.5693505], [126.9706639, 37.5693666]]]},
         "properties": {"ufid": "u1", "name": "세종대로", "rdln": "8.000000000000000", "rvwd": "40.000000000000000", "rddv": "RDD002"}}
    rec = R.parse_feature(f)
    assert rec["lanes"] == 8 and rec["width"] == 40.0 and rec["name"] == "세종대로"
    assert json.loads(rec["lines"]) == [[[126.970640, 37.569350], [126.970664, 37.569367]]]


def test_parse_feature_rejects_missing_lanes_or_geometry():
    base = {"geometry": {"type": "LineString", "coordinates": [[127.0, 37.5], [127.001, 37.5]]},
            "properties": {"ufid": "u2", "rdln": "2", "rvwd": ""}}
    assert R.parse_feature(base)["lanes"] == 2            # 폭이 비어 있어도 차로 수가 있으면 사용
    assert R.parse_feature({**base, "properties": {"ufid": "u2", "rdln": ""}}) is None
    assert R.parse_feature({**base, "geometry": {"type": "Point", "coordinates": [127.0, 37.5]}}) is None


def test_tiles_cover_bbox_without_gaps():
    ts = list(R.tiles((0.0, 0.0, 0.1, 0.05), step=0.04))
    assert len(ts) == 3 * 2
    assert min(t[0] for t in ts) == 0.0 and max(t[2] for t in ts) == 0.1
    assert min(t[1] for t in ts) == 0.0 and max(t[3] for t in ts) == 0.05
