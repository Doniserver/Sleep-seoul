import * as maplibregl from "maplibre-gl";
import type { Map as MlMap } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import { COLORS, LABELS, NODATA, step } from "./colors";
import { type Data, type Dong, HOURS, fmt, loadBuildings, loadSensors, sortedDongs } from "./data";
import { renderReport } from "./report";

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
        <label class="search">동네 찾기
          <input list="dong-list" id="q" placeholder="예: 역삼1동" autocomplete="off" />
        </label>
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

  // 배경 타일을 다 받을 때까지 기다리지 않고, 스타일만 준비되면 바로 색칠
  map.once("style.load", () => {
    // 배경지도의 글자·도로 레이어는 우리 색칠 위로 오도록 첫 symbol 레이어 앞에 끼운다
    const firstSymbol = map.getStyle().layers.find((l) => l.type === "symbol")?.id;
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
  const qInput = root.querySelector<HTMLInputElement>("#q")!;
  qInput.addEventListener("change", () => {
    const v = qInput.value.trim();
    const d = Object.values(data.dongs).find((x) => `${x.gu} ${x.name}` === v) ?? Object.values(data.dongs).find((x) => x.name === v);
    if (d) select(d.code, true);
  });
  return () => { stop(); map.remove(); };
}
