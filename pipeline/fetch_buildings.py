"""공동주택(K-APT) 수집 → 층간소음 위험 '추정' 등급 → web/public/data/buildings.json

  python -m pipeline.fetch_buildings

API (공공데이터포털, 국토교통부):
  - 단지 목록:   apis.data.go.kr/1613000/AptListService4/getSigunguAptList4   (sigunguCode)
  - 기본 정보:   apis.data.go.kr/1613000/AptBasisInfoServiceV5/getAphusBassInfoV5 (kaptCode)
기본 정보 응답에서 확인한 필드: kaptCode, kaptName, kaptAddr, kaptUsedate(YYYYMMDD), bjdCode(법정동 10자리),
  kaptdaCnt(세대수), codeAptNm, doroJuso.  응답에 좌표는 없음 → 지도 점 대신 동 단위로 집계.
단지 목록 응답의 필드는 실행 시 검사하고, 기대한 필드(kaptCode)가 없으면 멈춘다.

행정동 연결: K-APT는 법정동 코드만 준다. 같은 구 안에서 행정동 이름의 숫자·'제'를 뗀 이름(역삼1동→역삼동)이
법정동 이름과 같으면 그 법정동의 단지를 행정동에 연결한다(법정동 전체 기준임을 화면에 표시).
"""
from __future__ import annotations

import json
import os
import re
import sys
import time
from collections import Counter, defaultdict

import requests

from pipeline import config as C
from pipeline import metrics as M
from pipeline import sensors as S

LIST_URL = "https://apis.data.go.kr/1613000/AptListService4/getSigunguAptList4"
BASIS_URL = "https://apis.data.go.kr/1613000/AptBasisInfoServiceV5/getAphusBassInfoV5"
CACHE = C.KAPT / "kapt_basis.json"


def _key() -> str:
    k = os.environ.get("DATA_GO_KR_KEY")
    if not k:
        from dotenv import load_dotenv
        load_dotenv(C.ROOT / ".env")
        k = os.environ.get("DATA_GO_KR_KEY")
    if not k:
        sys.exit("DATA_GO_KR_KEY가 없습니다")
    return k


def _get(url: str, params: dict, retries=3) -> dict:
    for i in range(retries):
        r = requests.get(url, params={"serviceKey": _key(), **params}, timeout=60)
        if r.status_code == 200:
            try:
                return r.json()
            except ValueError:
                pass
        if r.status_code in (401, 403):
            raise SystemExit(f"API 키 오류({r.status_code}): {url.split('/')[-2]} 활용신청·승인 상태를 확인하세요")
        time.sleep(2 * (i + 1))
    raise RuntimeError(f"API 실패 {url}")


def _items(j: dict) -> list[dict]:
    body = j.get("response", {}).get("body", {})
    items = body.get("items", body.get("item"))
    if isinstance(items, dict):
        items = items.get("item", items)
    if isinstance(items, dict):
        items = [items]
    return items or []


def list_seoul_complexes(sgg_codes: list[str]) -> list[dict]:
    out = []
    for sgg in sgg_codes:
        page = 1
        while True:
            j = _get(LIST_URL, {"sigunguCode": sgg, "pageNo": page, "numOfRows": 1000})
            items = _items(j)
            if items and "kaptCode" not in items[0]:
                raise SystemExit(f"단지 목록 응답에 kaptCode가 없습니다. 실제 필드: {sorted(items[0])}")
            out += items
            total = int(j.get("response", {}).get("body", {}).get("totalCount", 0) or 0)
            if page * 1000 >= total or not items:
                break
            page += 1
        print(f"[kapt] {sgg}: 누적 {len(out)}")
    return out


def fetch_basis(codes: list[str]) -> dict[str, dict]:
    C.KAPT.mkdir(parents=True, exist_ok=True)
    cache = json.loads(CACHE.read_text(encoding="utf-8")) if CACHE.exists() else {}
    todo = [c for c in codes if c not in cache]
    for i, code in enumerate(todo, 1):
        items = _items(_get(BASIS_URL, {"kaptCode": code}))
        cache[code] = items[0] if items else {}
        if i % 200 == 0:
            CACHE.write_text(json.dumps(cache, ensure_ascii=False), encoding="utf-8")
            print(f"[kapt] 기본정보 {i}/{len(todo)}")
    CACHE.write_text(json.dumps(cache, ensure_ascii=False), encoding="utf-8")
    return cache


def stem(name: str) -> str:
    """행정동 이름 → 법정동 이름 후보: 숫자·가운뎃점·'제'를 지움. 예) 상계3·4동→상계동, 종로1·2·3·4가동→종로동가 X"""
    s = re.sub(r"제?\d+(·\d+)*(가)?동$", "동", name)
    return s


def run():
    feats = S.load_boundaries()
    sggs = sorted({f["properties"]["sgg"] for f in feats})
    lst = list_seoul_complexes(sggs)
    codes = sorted({x["kaptCode"] for x in lst})
    basis = fetch_basis(codes)

    # 법정동코드 → 법정동 이름: 기본정보 kaptAddr "서울특별시 ○○구 ○○동 ..." 세 번째 토큰
    bjd_name: dict[str, str] = {}
    complexes = []
    for code in codes:
        b = basis.get(code) or {}
        if not b:
            continue
        addr = (b.get("kaptAddr") or "").split()
        bjd = str(b.get("bjdCode") or "")
        if len(addr) >= 3 and bjd:
            bjd_name.setdefault(bjd, addr[2])
        ud = str(b.get("kaptUsedate") or "")
        complexes.append({
            "code": code, "name": b.get("kaptName"), "bjd": bjd, "bjd_name": bjd_name.get(bjd),
            "use_date": ud or None, "year": int(ud[:4]) if ud[:4].isdigit() else None,
            "grade": M.floor_noise_grade(ud), "households": b.get("kaptdaCnt"), "type": b.get("codeAptNm"),
            "lat": None, "lon": None, "adm": None,
        })

    # 행정동 ↔ 법정동(같은 구 + 이름 stem)
    by_bjd: dict[tuple[str, str], list[dict]] = defaultdict(list)
    for c in complexes:
        if c["bjd"] and c["bjd_name"]:
            by_bjd[(c["bjd"][:5], c["bjd_name"])].append(c)
    by_dong, link = {}, {}
    for f in feats:
        p = f["properties"]
        nm = p["adm_nm"].split()[-1]
        key = (p["sgg"], stem(nm))
        cs = by_bjd.get(key)
        if not cs:
            continue
        cnt = Counter(c["grade"] for c in cs if c["grade"])
        by_dong[p["adm_cd2"]] = dict(cnt)
        link[p["adm_cd2"]] = key[1]
    out = {"generated_at": __import__("datetime").date.today().isoformat(),
           "source": "국토교통부 공동주택 단지 목록·기본 정보(K-APT)",
           "note": "법정동 단위 집계를 이름이 같은 행정동에 연결함. 좌표 없음.",
           "complexes": complexes, "by_dong": by_dong, "bjd_of_dong": link}
    C.WEB_DATA.mkdir(parents=True, exist_ok=True)
    (C.WEB_DATA / "buildings.json").write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    print(f"[kapt] 단지 {len(complexes)}개, 연결된 행정동 {len(by_dong)}/{len(feats)}")


if __name__ == "__main__":
    run()
