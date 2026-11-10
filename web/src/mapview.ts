import * as maplibregl from "maplibre-gl";
import type { Map as MlMap } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import { COLORS, LABELS, NODATA, colorFor, step } from "./colors";
import { type Data, type Dong, HOURS, fmt, loadBuildings, loadSensors, sortedDongs } from "./data";
import { type Near, type Place, dongAt, nearestSensors, searchPlaces } from "./place";
import { renderReport } from "./report";

function escHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

/** 장소 카드: 그 위치 자체를 잰 값이 아님을 분명히 */
function placeCard(p: Place, d: Dong, near: Near[]): HTMLElement {
  const el = document.createElement("section");
  el.className = "placecard";
  el.setAttribute("aria-label", `${p.name} 주변 소음`);
  const m = (x: number) => (x < 1000 ? `${Math.round(x / 10) * 10}m` : `${(x / 1000).toFixed(1)}km`);
  el.innerHTML = `
    <p class="pc-kicker">검색한 장소</p>
    <h2>${escHtml(p.name)}</h2>
    ${p.addr ? `<p class="hint">${escHtml(p.addr)}</p>` : ""}
    <div class="pc-row">
      <div><span class="chip sm" style="background:${colorFor(d.l_night)}"></span><b>${fmt(d.l_night, 1, "dB")}</b>
        <p class="lbl">${escHtml(d.gu)} ${escHtml(d.name)} 대표값(밤)</p></div>
      ${near[0] ? `<div><span class="chip sm" style="background:${colorFor(near[0].s.l_night)}"></span><b>${fmt(near[0].s.l_night, 1, "dB")}</b>
        <p class="lbl">가장 가까운 센서 · ${m(near[0].d)}</p></div>` : ""}
    </div>
    ${near.length ? `<ol class="pc-near">${near.map((n) => `<li>센서 ${n.s.sn} · ${m(n.d)} · ${escHtml(n.s.rgn_ko)} · 밤 <b>${fmt(n.s.l_night, 1, "dB")}</b></li>`).join("")}</ol>`
                  : `<p class="hint">2km 안에 쓸 수 있는 센서가 없습니다.</p>`}
    <p class="hint">이 건물 자체를 잰 값이 아닙니다. 지도에 점선으로 이은 <b>가까운 길가 센서</b>의 밤 소음과, 이 장소가 속한 <b>동네 대표값</b>입니다. 센서와 건물 사이 거리·도로 방향에 따라 실제와 다를 수 있습니다.</p>`;
  return el;
}

// 번들러가 워커 파일을 옮기므로 위치를 직접 알려준다
maplibregl.setWorkerUrl(workerUrl);

// 무료·키 없는 배경지도 (OpenFreeMap, OpenStreetMap 데이터)
const STYLE_URL = "https://tiles.openfreemap.org/styles/dark";

// '높음' 등급 단지 비율 0~100% (어두움 → 밝음)
const BLD_COLORS = ["#2f3b55", "#5b4f7a", "#8f6585", "#c98471", "#ffb38a"];
const BLD_LABELS = ["20% 미만", "20–40%", "40–60%", "60–80%", "80% 이상"];

interface State { hour: number | "all"; month: string | "all"; selected: string | null; three: boolean; playing: number | null }

export function renderMap(root: HTMLElement, data: Data, params: URLSearchParams, onCompare: (code: string) => void) {
  const months = data.meta.months;
  root.innerHTML = `
  <div class="mapgrid">
    <section class="mapwrap" aria-label="서울의 밤 지도">
      <div id="map" role="application" aria-label="행정동별 밤 소음 지도. 아래 검색창으로도 동네를 고를 수 있습니다."></div>
      <div class="ctrl">
        <form class="search" id="qform" role="search">
          <label for="q">동네·건물·장소 찾기</label>
          <div class="qrow">
            <input list="dong-list" id="q" placeholder="예: 역삼1동, 호암교수회관, 강남역" autocomplete="off" />
            <button type="submit">찾기</button>
          </div>
          <p id="qmsg" class="qmsg" aria-live="polite"></p>
          <ul id="qres" class="qres"></ul>
        </form>
        <datalist id="dong-list">${sortedDongs(data).map((d) => `<option value="${d.gu} ${d.name}"></option>`).join("")}</datalist>
        <div class="row">
          <label>기간 <select id="month"><option value="all">전체 (${data.meta.period.start} ~ ${data.meta.period.end})</option>
            ${months.map((m) => `<option value="${m}">${m.replace("-", "년 ")}월</option>`).join("")}</select></label>
        </div>
        <div class="row slider">
          <button type="button" id="play" aria-pressed="false" aria-label="밤 시간 재생">▶</button>
          <label class="grow">시간 <span id="hlabel" aria-live="polite">밤 전체</span>
            <input type="range" id="hour" min="0" max="8" step="1" value="0" aria-describedby="hlabel" />
          </label>
        </div>
        <div class="row basemap" role="group" aria-label="배경 지도">
          <span>배경</span>
          <button type="button" id="bm-normal" aria-pressed="true">일반 지도</button>
          <button type="button" id="bm-sat" aria-pressed="false">위성 지도</button>
        </div>
        <label class="opacity">색 진하기 <span id="oplabel">80%</span>
          <input type="range" id="op" min="20" max="100" step="5" value="80" aria-describedby="oplabel" />
        </label>
        <div class="row toggles">
          <label><input type="checkbox" id="t3d" /> 3D 기둥</label>
          <label><input type="checkbox" id="tsen" /> 센서 위치</label>
          <label><input type="checkbox" id="tbld" /> 층간소음 위험(추정)</label>
        </div>
        <div class="legend" aria-label="색 범례">
          <div id="nlegend"><p>밤 소음 (dB)</p>
          <ul>${COLORS.map((c, i) => `<li><span style="background:${c}"></span>${LABELS[i]}</li>`).join("")}
          <li><span style="background:${NODATA}"></span>데이터 없음</li></ul></div>
          <div id="blegend" hidden><p>공동주택 중 '높음'(~2007년 사용승인) 단지 비율 <span class="est">추정</span></p>
          <ul>${BLD_COLORS.map((c, i) => `<li><span style="background:${c}"></span>${BLD_LABELS[i]}</li>`).join("")}
          <li><span style="background:${NODATA}"></span>단지 없음·연결 안 됨</li></ul></div>
        </div>
      </div>
    </section>
    <aside id="panel" class="panel" aria-live="polite">
      <div class="intro">
        <h2>서울의 밤</h2>
        <p>서울 행정동 ${data.meta.counts.dongs_with_data}곳의 밤(22~06시) 바깥 소음입니다. 동을 누르거나 위에서 검색하면 동네 리포트가 열립니다.</p>
        <p>서울 행정동 중앙값 <b>${fmt(data.meta.seoul.l_night_median, 1, "dB")}</b> · WHO 야간 목표는 집 밖 연평균 <b>40dB</b>입니다.</p>
        <h3>가장 조용한 동 5곳</h3><ol id="top-q"></ol>
        <h3>가장 시끄러운 동 5곳</h3><ol id="top-l"></ol>
        <p class="hint">센서가 1개뿐인 동이 많습니다. 순위는 그 센서 위치의 영향을 받습니다.</p>
      </div>
    </aside>
  </div>`;

  const st: State = { hour: "all", month: "all", selected: params.get("d"), three: false, playing: null };
  const map: MlMap = new maplibregl.Map({ container: "map", style: STYLE_URL, center: [126.99, 37.56], zoom: 10.2, minZoom: 9, maxZoom: 16, attributionControl: { compact: true } });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");

  const valueOf = (d: Dong): number | null => {
    if (st.month !== "all") return d.months?.[st.month]?.l_night ?? null;
    if (st.hour !== "all") return d.by_hour?.[String(st.hour)] ?? null;
    return d.l_night;
  };

  const top = () => {
    const vs = Object.values(data.dongs).map((d) => ({ d, v: valueOf(d) })).filter((x) => x.v != null) as { d: Dong; v: number }[];
    vs.sort((a, b) => a.v - b.v);
    const li = (x: { d: Dong; v: number }) => `<li><button type="button" class="link" data-code="${x.d.code}">${x.d.gu} ${x.d.name}</button> ${x.v.toFixed(1)}dB <small>센서 ${x.d.n_sensors}</small></li>`;
    const q = root.querySelector("#top-q"), l = root.querySelector("#top-l");
    if (q) q.innerHTML = vs.slice(0, 5).map(li).join("");
    if (l) l.innerHTML = vs.slice(-5).reverse().map(li).join("");
    root.querySelectorAll<HTMLButtonElement>(".intro button[data-code]").forEach((b) => b.addEventListener("click", () => select(b.dataset.code!, true)));
  };

  const paint = () => {
    for (const f of data.geo.features) {
      const d = data.dongs[(f.properties as any).code];
      const v = d ? valueOf(d) : null;
      map.setFeatureState({ source: "dongs", id: f.id as number }, { v: v ?? 0, has: v != null });
    }
    top();
  };

  const panel = root.querySelector<HTMLElement>("#panel")!;
  const select = (code: string, fly = false) => {
    const d = data.dongs[code];
    if (!d) return;
    st.selected = code;
    history.replaceState(null, "", `#/map?d=${code}`);
    map.setFilter("sel", ["==", ["get", "code"], code]);
    renderReport(panel, data, d, { onCompare });
    if (fly) {
      const f = data.geo.features.find((x) => (x.properties as any).code === code);
      if (f) {
        const b = new maplibregl.LngLatBounds();
        const walk = (c: any) => (typeof c[0] === "number" ? b.extend(c as [number, number]) : c.forEach(walk));
        walk((f.geometry as any).coordinates);
        map.fitBounds(b, { padding: 60, maxZoom: 14, duration: 600 });
      }
    }
  };

  let baseDrawLayers: string[] = [];
  // 배경 타일을 다 받을 때까지 기다리지 않고, 스타일만 준비되면 바로 색칠
  map.once("style.load", () => {
    // 배경지도의 글자·도로 레이어는 우리 색칠 위로 오도록 첫 symbol 레이어 앞에 끼운다
    const firstSymbol = map.getStyle().layers.find((l) => l.type === "symbol")?.id;
    // 일반 지도의 그림 레이어(도로·건물·물 등). 위성 모드에서는 숨기고 지명 글자(symbol)만 남긴다
    baseDrawLayers = map.getStyle().layers.filter((l) => l.type !== "symbol" && l.type !== "background").map((l) => l.id);
    // 위성 영상 (Esri World Imagery, 키 없음). 처음엔 숨겨 두고 버튼으로 켠다
    map.addSource("sat", { type: "raster", tileSize: 256, maxzoom: 18,
      tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
      attribution: "위성: Esri, Maxar, Earthstar Geographics" });
    map.addLayer({ id: "sat", type: "raster", source: "sat", layout: { visibility: "none" } }, firstSymbol);
    map.addSource("dongs", { type: "geojson", data: data.geo });
    const color: any = ["case", ["boolean", ["feature-state", "has"], false], step(["feature-state", "v"]), NODATA];
    map.addLayer({ id: "fill", type: "fill", source: "dongs", paint: { "fill-color": color, "fill-opacity": 0.8 } }, firstSymbol);
    map.addLayer({ id: "ext", type: "fill-extrusion", source: "dongs", layout: { visibility: "none" },
      paint: { "fill-extrusion-color": color, "fill-extrusion-opacity": 0.9,
        "fill-extrusion-height": ["case", ["boolean", ["feature-state", "has"], false], ["*", ["max", 0, ["-", ["feature-state", "v"], 33]], 120], 0] } });
    map.addLayer({ id: "line", type: "line", source: "dongs", paint: { "line-color": "#0b111c", "line-width": 0.6 } }, firstSymbol);
    map.addLayer({ id: "sel", type: "line", source: "dongs", filter: ["==", ["get", "code"], ""], paint: { "line-color": "#ffffff", "line-width": 2.5 } });
    paint();
    if (st.selected) select(st.selected, true);

    const pop = new maplibregl.Popup({ closeButton: false, closeOnClick: false, className: "tip" });
    map.on("mousemove", "fill", (e) => {
      const f = e.features?.[0]; if (!f) return;
      const d = data.dongs[(f.properties as any).code];
      map.getCanvas().style.cursor = "pointer";
      pop.setLngLat(e.lngLat).setHTML(`<b>${d.gu} ${d.name}</b><br>${fmt(d ? valueOf(d) : null, 1, "dB")}`).addTo(map);
    });
    map.on("mouseleave", "fill", () => { map.getCanvas().style.cursor = ""; pop.remove(); });
    map.on("click", "fill", (e) => { const f = e.features?.[0]; if (f) select((f.properties as any).code); });
  });

  // 컨트롤
  const hour = root.querySelector<HTMLInputElement>("#hour")!;
  const hlabel = root.querySelector<HTMLElement>("#hlabel")!;
  const monthSel = root.querySelector<HTMLSelectElement>("#month")!;
  const play = root.querySelector<HTMLButtonElement>("#play")!;
  const setHour = (i: number) => {
    hour.value = String(i);
    st.hour = i === 0 ? "all" : HOURS[i - 1];
    hlabel.textContent = st.hour === "all" ? "밤 전체" : `${st.hour}시~${(st.hour + 1) % 24}시`;
    paint();
  };
  hour.addEventListener("input", () => setHour(+hour.value));
  monthSel.addEventListener("change", () => {
    st.month = monthSel.value;
    const monthly = st.month !== "all";
    hour.disabled = play.disabled = monthly;
    if (monthly) { stop(); setHour(0); hlabel.textContent = "밤 전체 (월별 보기에서는 시간 선택 없음)"; }
    paint();
  });
  const stop = () => { if (st.playing) { clearInterval(st.playing); st.playing = null; } play.textContent = "▶"; play.setAttribute("aria-pressed", "false"); };
  play.addEventListener("click", () => {
    if (st.playing) return stop();
    play.textContent = "❚❚"; play.setAttribute("aria-pressed", "true");
    let i = +hour.value; if (i === 0) i = 0;
    st.playing = window.setInterval(() => { i = i >= 8 ? 1 : i + 1; setHour(i); }, 1100);
  });
  // 배경 지도 전환 + 색 진하기
  const bmNormal = root.querySelector<HTMLButtonElement>("#bm-normal")!;
  const bmSat = root.querySelector<HTMLButtonElement>("#bm-sat")!;
  const op = root.querySelector<HTMLInputElement>("#op")!;
  const opLabel = root.querySelector<HTMLElement>("#oplabel")!;
  const applyOpacity = () => {
    const v = +op.value / 100;
    opLabel.textContent = `${op.value}%`;
    if (!map.getLayer("fill")) return;
    map.setPaintProperty("fill", "fill-opacity", v);
    map.setPaintProperty("ext", "fill-extrusion-opacity", Math.min(1, v + 0.1));
    if (map.getLayer("bfill")) map.setPaintProperty("bfill", "fill-opacity", Math.min(1, v + 0.05));
  };
  const setBasemap = (sat: boolean) => {
    bmNormal.setAttribute("aria-pressed", String(!sat));
    bmSat.setAttribute("aria-pressed", String(sat));
    if (!map.getLayer("sat")) return;
    map.setLayoutProperty("sat", "visibility", sat ? "visible" : "none");
    for (const id of baseDrawLayers) map.setLayoutProperty(id, "visibility", sat ? "none" : "visible");
    // 위성 위에서는 동 경계를 흰 선으로, 색은 조금 옅게 해서 사진이 보이게
    map.setPaintProperty("line", "line-color", sat ? "#ffffff" : "#0b111c");
    map.setPaintProperty("line", "line-opacity", sat ? 0.55 : 1);
    op.value = sat ? "50" : "80";
    applyOpacity();
  };
  bmNormal.addEventListener("click", () => setBasemap(false));
  bmSat.addEventListener("click", () => setBasemap(true));
  op.addEventListener("input", applyOpacity);

  root.querySelector<HTMLInputElement>("#t3d")!.addEventListener("change", (e) => {
    const on = (e.target as HTMLInputElement).checked;
    map.setLayoutProperty("ext", "visibility", on ? "visible" : "none");
    map.setLayoutProperty("fill", "visibility", on ? "none" : "visible");
    map.easeTo({ pitch: on ? 55 : 0, bearing: on ? -15 : 0, duration: 700 });
  });
  root.querySelector<HTMLInputElement>("#tsen")!.addEventListener("change", async (e) => {
    const on = (e.target as HTMLInputElement).checked;
    if (!map.getSource("sensors")) {
      const s = await loadSensors(data);
      map.addSource("sensors", { type: "geojson", data: { type: "FeatureCollection", features: s.map((x) => ({ type: "Feature", properties: { ...x }, geometry: { type: "Point", coordinates: [x.lon, x.lat] } })) } as any });
      map.addLayer({ id: "sensors", type: "circle", source: "sensors", paint: {
        "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 2, 15, 6],
        "circle-color": ["case", ["get", "used"], "#ffffff", "#8a93a6"], "circle-stroke-color": "#0b111c", "circle-stroke-width": 1 } });
      map.on("click", "sensors", (ev) => {
        const p: any = ev.features?.[0]?.properties; if (!p) return;
        new maplibregl.Popup().setLngLat(ev.lngLat).setHTML(`<b>센서 ${p.sn}</b><br>${p.rgn_ko}<br>밤 ${p.l_night ?? "—"}dB<br>${p.used ? "동네 대표값에 사용" : p.noise_ok ? "대표값에 쓰지 않음(공원·도로변 등)" : "제외(결측·고장 의심)"}`).addTo(map);
      });
    }
    map.setLayoutProperty("sensors", "visibility", on ? "visible" : "none");
  });
  root.querySelector<HTMLInputElement>("#tbld")!.addEventListener("change", async (e) => {
    const el = e.target as HTMLInputElement;
    const b = await loadBuildings(data);
    const legend = root.querySelector<HTMLElement>("#blegend")!;
    if (!b) { el.checked = false; el.disabled = true; el.parentElement!.append(" (준비 중)"); return; }
    // K-APT에는 좌표가 없어 단지 점 대신 동별 '높음' 등급 단지 비율로 색칠
    if (!map.getLayer("bfill")) {
      for (const f of data.geo.features) {
        const s = b.by_dong[(f.properties as any).code];
        const tot = s ? Object.values(s).reduce((a, x) => a + x, 0) : 0;
        map.setFeatureState({ source: "dongs", id: f.id as number }, { bh: tot > 0, br: tot ? (s!["높음"] ?? 0) / tot : 0, bn: tot });
      }
      map.addLayer({ id: "bfill", type: "fill", source: "dongs", layout: { visibility: "none" }, paint: {
        "fill-color": ["case", ["boolean", ["feature-state", "bh"], false],
          ["step", ["feature-state", "br"], BLD_COLORS[0], 0.2, BLD_COLORS[1], 0.4, BLD_COLORS[2], 0.6, BLD_COLORS[3], 0.8, BLD_COLORS[4]], NODATA] as any,
        "fill-opacity": 0.85 } }, "line");
    }
    map.setLayoutProperty("bfill", "visibility", el.checked ? "visible" : "none");
    legend.hidden = !el.checked;
    root.querySelector<HTMLElement>("#nlegend")!.hidden = el.checked;
  });
  // ── 검색: 동 이름이면 동, 아니면 건물·장소 ──────────────────
  const qInput = root.querySelector<HTMLInputElement>("#q")!;
  const qmsg = root.querySelector<HTMLElement>("#qmsg")!;
  const qres = root.querySelector<HTMLUListElement>("#qres")!;
  const findDong = (v: string) =>
    Object.values(data.dongs).find((x) => `${x.gu} ${x.name}` === v) ?? Object.values(data.dongs).find((x) => x.name === v);
  qInput.addEventListener("change", () => {
    const d = findDong(qInput.value.trim());
    if (d) { clearPlace(); qres.innerHTML = ""; qmsg.textContent = ""; select(d.code, true); }
  });
  root.querySelector<HTMLFormElement>("#qform")!.addEventListener("submit", async (e) => {
    e.preventDefault();
    const v = qInput.value.trim();
    qres.innerHTML = "";
    if (!v) return;
    const d = findDong(v);
    if (d) { clearPlace(); qmsg.textContent = ""; select(d.code, true); return; }
    qmsg.textContent = "찾는 중…";
    try {
      const { places, used } = await searchPlaces(v, data);
      if (!places.length) { qmsg.textContent = `서울 안에서 "${v}"을(를) 찾지 못했습니다. 건물 이름만 넣어 보세요(예: 호암교수회관).`; return; }
      qmsg.textContent = used !== v ? `"${used}"(으)로 찾은 결과입니다.` : `${places.length}곳을 찾았습니다.`;
      qres.innerHTML = places.map((p, i) => `<li><button type="button" class="link" data-i="${i}">${escHtml(p.name)}</button> <small>${escHtml(p.addr)}</small></li>`).join("");
      qres.querySelectorAll<HTMLButtonElement>("button").forEach((b) => b.addEventListener("click", () => showPlace(places[+b.dataset.i!])));
      showPlace(places[0]);
    } catch (err) {
      qmsg.textContent = `장소 검색 서비스에 연결하지 못했습니다. (${String(err)})`;
    }
  });

  let marker: maplibregl.Marker | null = null;
  const clearPlace = () => {
    marker?.remove(); marker = null;
    (map.getSource("near") as maplibregl.GeoJSONSource | undefined)?.setData({ type: "FeatureCollection", features: [] });
  };
  const showPlace = async (p: Place) => {
    const code = dongAt(data, p.lon, p.lat);
    if (!code) return;
    const sensors = await loadSensors(data);
    const near = nearestSensors(sensors, p.lon, p.lat);
    clearPlace();
    marker = new maplibregl.Marker({ color: "#f5b041" }).setLngLat([p.lon, p.lat]).addTo(map);
    const fc: any = { type: "FeatureCollection", features: near.flatMap((n, i) => [
      { type: "Feature", properties: { kind: "line" }, geometry: { type: "LineString", coordinates: [[p.lon, p.lat], [n.s.lon, n.s.lat]] } },
      { type: "Feature", properties: { kind: "pt", label: `${i + 1}`, v: n.s.l_night }, geometry: { type: "Point", coordinates: [n.s.lon, n.s.lat] } },
    ]) };
    if (!map.getSource("near")) {
      map.addSource("near", { type: "geojson", data: fc });
      map.addLayer({ id: "near-line", type: "line", source: "near", filter: ["==", ["get", "kind"], "line"],
        paint: { "line-color": "#ffffff", "line-width": 1.5, "line-dasharray": [2, 2] } });
      map.addLayer({ id: "near-pt", type: "circle", source: "near", filter: ["==", ["get", "kind"], "pt"],
        paint: { "circle-radius": 9, "circle-color": step(["get", "v"]) as any, "circle-stroke-color": "#ffffff", "circle-stroke-width": 2 } });
    } else (map.getSource("near") as maplibregl.GeoJSONSource).setData(fc);
    select(code);
    map.flyTo({ center: [p.lon, p.lat], zoom: 15, duration: 700 });
    history.replaceState(null, "", `#/map?d=${code}&p=${p.lat.toFixed(5)},${p.lon.toFixed(5)}&n=${encodeURIComponent(p.name)}`);
    panel.prepend(placeCard(p, data.dongs[code], near));
  };

  // 공유한 주소로 들어오면 장소 다시 표시
  const pp = params.get("p");
  if (pp) {
    const [lat, lon] = pp.split(",").map(Number);
    const pl: Place = { name: params.get("n") ?? "선택한 장소", addr: "", lat, lon };
    map.once("idle", () => showPlace(pl));
  }
  return () => { stop(); map.remove(); };
}
