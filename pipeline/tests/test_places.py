import pandas as pd
import pytest

from pipeline.places_categories import categorize
from pipeline.fetch_places import group_buildings


@pytest.mark.parametrize("l,s,want", [
    ("음식", "카페", "cafe"), ("음식", "빵/도넛", "cafe"), ("음식", "요리 주점", "bar"),
    ("음식", "국/탕/찌개류", "food"), ("보건의료", "치과의원", "hospital"),
    ("소매", "약국", "pharmacy"), ("소매", "편의점", "mart"), ("예술·스포츠", "헬스장", "gym"),
    ("교육", "요가/필라테스 학원", "gym"), ("교육", "입시·교과학원", "academy"),
    ("예술·스포츠", "노래방", "leisure"), ("수리·개인", "목욕탕/사우나", "leisure"),
    ("수리·개인", "미용실", "life"), ("과학·기술", "변호사", "office"),
    ("소매", "가구 소매업", "etc"), (None, None, "etc"),
])
def test_categorize(l, s, want):
    assert categorize(l, s) == want


def test_group_buildings_by_building_number_and_sort_by_floor():
    df = pd.DataFrame([
        {"bldMngNo": "B1", "bldNm": "가빌딩", "lat": 37.5, "lon": 127.0, "cat": "cafe", "name": "카페A", "flrNo": "2", "scls": "카페"},
        {"bldMngNo": "B1", "bldNm": "가빌딩", "lat": 37.50001, "lon": 127.00001, "cat": "food", "name": "식당B", "flrNo": "1", "scls": "중국집"},
        {"bldMngNo": "", "bldNm": "", "lat": 37.6, "lon": 127.1, "cat": "mart", "name": "편의점C", "flrNo": "", "scls": "편의점"},
    ])
    out = group_buildings(df)
    assert len(out) == 2
    b1 = next(b for b in out if b[2] == "가빌딩")
    assert [s[1] for s in b1[3]] == ["식당B", "카페A"]   # 층 순서
    assert b1[0] == pytest.approx(37.500005, abs=1e-5)
