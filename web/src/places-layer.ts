// 생활시설 레이어: 분류 필터 막대 + 건물 단위 점 + 건물 팝업 (상가정보)
import * as maplibregl from "maplibre-gl";
import type { Map as MlMap } from "maplibre-gl";
import { type Data, type PlaceBuilding, type PlacesSummary, PLACE_COLORS, loadPlaces, loadPlacesSummary } from "./data";

const MIN_ZOOM = 13.5; // 이보다 멀면 점을 그리지 않음(가게 수십만 곳)
const MAX_DONGS = 16; // 한 번에 불러올 동 파일 수

function esc(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

export async function attachPlaces(map: MlMap, bar: HTMLElement, data: Data) {
  const sum = await loadPlacesSummary();
  if (!sum) { bar.hidden = true; return { refresh() {} }; }
  const cats = sum.categories;
  const on = new Set(cats.filter((c) => c.default).map((c) => c.key));
  bar.innerHTML = `
    <div class="chips" role="group" aria-label="생활시설 보기">
      ${cats.map((c) => `<button type="button" class="chip-btn" data-k="${c.key}" aria-pressed="${on.has(c.key)}">
        <span class="dot" style="background:${PLACE_COLORS[c.key]}"></span>${c.name}</button>`).join("")}
    </div>
    <p class="chips-hint" id="pl-hint" aria-live="polite"></p>`;
  const hint = bar.querySelector<HTMLElement>("#pl-hint")!;

  // 동 경계 상자 (보이는 동만 불러오기)
  const boxes = data.geo.features.map((f) => {
    const g: any = f.geometry;
    const polys = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
    let x0 = 999, y0 = 999, x1 = -999, y1 = -999;
    for (const p of polys) for (const [x, y] of p[0]) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
    return { code: (f.properties as any).code as string, b: [x0, y0, x1, y1] };
  });
  const loaded = new Map<string, PlaceBuilding[]>();
  const features: any[] = [];
  const addDong = (code: string, bs: PlaceBuilding[]) => {
    bs.forEach((b, i) => {
      const props: any = { code, i, name: b[2] };
      for (let k = 0; k < cats.length; k++) props["c" + k] = 0;
      for (const s of b[3]) props["c" + s[0]]++;
      features.push({ type: "Feature", properties: props, geometry: { type: "Point", coordinates: [b[1], b[0]] } });
    });
  };

  map.addSource("places", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
  map.addLayer({ id: "pl", type: "circle", source: "places", minzoom: MIN_ZOOM - 0.01, paint: {
    "circle-color": "#999", "circle-radius": 4, "circle-stroke-color": "#ffffff", "circle-stroke-width": 1.2, "circle-opacity": 0.95,
  } });

  const style = () => {
    const keys = cats.map((c, k) => ({ key: c.key, k })).filter((x) => on.has(x.key));
    if (!keys.length) { map.setFilter("pl", ["==", 1, 0]); return; }
    map.setFilter("pl", ["any", ...keys.map(({ k }) => [">", ["get", "c" + k], 0])] as any);
    // 색: 켜진 분류 중 그 건물에 가장 많은 것
    const cnt = (k: number) => ["get", "c" + k];
    const color: any[] = ["case"];
    keys.forEach(({ key, k }) => {
      const others = keys.filter((o) => o.k !== k).map((o) => [">=", cnt(k), cnt(o.k)]);
      color.push(others.length ? ["all", [">", cnt(k), 0], ...others] : [">", cnt(k), 0], PLACE_COLORS[key]);
    });
    color.push("#999");
    map.setPaintProperty("pl", "circle-color", color as any);
    const total: any = keys.length === 1 ? cnt(keys[0].k) : ["+", ...keys.map(({ k }) => cnt(k))];
    map.setPaintProperty("pl", "circle-radius", ["interpolate", ["linear"], ["zoom"],
      13.5, ["interpolate", ["linear"], total, 1, 2.5, 10, 5, 40, 8],
      17, ["interpolate", ["linear"], total, 1, 6, 10, 11, 40, 16]] as any);
  };

  let busy = 0;
  const refresh = async () => {
    const z = map.getZoom();
    if (z < MIN_ZOOM) { hint.textContent = "지도를 확대하면 건물마다 가게·시설이 보입니다."; return; }
    const bd = map.getBounds();
    const want = boxes.filter(({ b }) => !(b[2] < bd.getWest() || b[0] > bd.getEast() || b[3] < bd.getSouth() || b[1] > bd.getNorth()))
      .map((x) => x.code).filter((c) => !loaded.has(c)).slice(0, MAX_DONGS);
    if (!want.length) { hint.textContent = ""; return; }
    const my = ++busy;
    hint.textContent = "가게·시설 불러오는 중…";
    const got = await Promise.all(want.map(async (c) => [c, await loadPlaces(c)] as const));
    for (const [c, bs] of got) if (!loaded.has(c)) { loaded.set(c, bs); addDong(c, bs); }
    (map.getSource("places") as maplibregl.GeoJSONSource).setData({ type: "FeatureCollection", features } as any);
    if (my === busy) hint.textContent = "";
  };

  bar.querySelectorAll<HTMLButtonElement>(".chip-btn").forEach((b) => b.addEventListener("click", () => {
    const k = b.dataset.k!;
    if (on.has(k)) on.delete(k); else on.add(k);
    b.setAttribute("aria-pressed", String(on.has(k)));
    style();
  }));

  // 건물 팝업: 켜진 분류의 가게를 층 순서대로
  map.on("click", "pl", (e) => {
    const p: any = e.features?.[0]?.properties;
    if (!p) return;
    const b = loaded.get(p.code)?.[p.i];
    if (!b) return;
    const list = b[3].filter((s) => on.has(cats[s[0]].key));
    const counts = cats.map((c, k) => ({ c, n: list.filter((s) => s[0] === k).length })).filter((x) => x.n);
    const html = `<div class="bpop">
      <b>${esc(b[2] || "건물 이름 없음")}</b>
      <p class="bpop-c">${counts.map((x) => `<span><i style="background:${PLACE_COLORS[x.c.key]}"></i>${x.c.name} ${x.n}</span>`).join("")}</p>
      <ul>${list.slice(0, 60).map((s) => `<li><i style="background:${PLACE_COLORS[cats[s[0]].key]}"></i><span class="fl">${s[2] ? esc(s[2]) + "층" : ""}</span> ${esc(s[1])} <small>${esc(s[3])}</small></li>`).join("")}</ul>
      ${list.length > 60 ? `<p class="bpop-more">외 ${list.length - 60}곳</p>` : ""}
      <p class="bpop-src">상가정보 ${sum.stdrYm.slice(0, 4)}년 ${+sum.stdrYm.slice(4)}월 기준 · 영업시간 정보 없음</p></div>`;
    new maplibregl.Popup({ maxWidth: "320px" }).setLngLat(e.lngLat).setHTML(html).addTo(map);
  });
  map.on("mouseenter", "pl", () => { map.getCanvas().style.cursor = "pointer"; });
  map.on("mouseleave", "pl", () => { map.getCanvas().style.cursor = ""; });

  style();
  map.on("moveend", refresh);
  refresh();
  return { refresh };
}

/** 동네 리포트·비교용: 분류별 개수 표 */
export function placeSummaryHtml(sum: PlacesSummary, code: string, title = "생활시설"): string {
  const c = sum.dongs[code] ?? {};
  const main = sum.categories.filter((x) => x.key !== "etc");
  const total = Object.values(c).reduce((a, b) => a + b, 0);
  return `<section class="facil" aria-label="${title}">
    <h3>${title} <small>${total.toLocaleString()}곳</small></h3>
    <div class="facil-grid">${main.map((x) => {
      const n = c[x.key] ?? 0, m = sum.seoul_median[x.key] ?? 0;
      const rel = m > 0 ? n / m : 0;
      const tag = m === 0 ? "" : rel >= 1.5 ? `<em class="up">서울 동 중앙값의 ${rel.toFixed(1)}배</em>` : rel <= 0.5 ? `<em class="down">중앙값의 ${Math.round(rel * 100)}%</em>` : `<em>중앙값 ${Math.round(m)}곳</em>`;
      return `<div><span class="dot" style="background:${PLACE_COLORS[x.key]}"></span><span class="fn">${x.name}</span><b>${n.toLocaleString()}</b>${tag}</div>`;
    }).join("")}</div>
    <p class="hint">${sum.source.name} ${sum.stdrYm.slice(0, 4)}년 ${+sum.stdrYm.slice(4)}월 기준. 영업 중인 가게 기준이며 학교·관공서는 포함되지 않습니다. 지도를 확대하면 건물마다 볼 수 있습니다.</p>
  </section>`;
}
