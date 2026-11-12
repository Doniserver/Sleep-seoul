import * as maplibregl from "maplibre-gl";
import type { Map as MlMap, StyleSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import { BREAKS, COLORS, NODATA, colorFor, step } from "./colors";
import { type Data, type Dong, type YearInfo, fmt, loadBuildings, loadSensors, loadYear, loadYearsIndex, sortedDongs } from "./data";
import { type Near, type Place, dongAt, nearestSensors, searchPlaces } from "./place";
import { DETAIL_MID, DETAIL_SPAN, DETAIL_STOPS, type NoiseMap, type Profile, detailCss, loadNoiseMap } from "./detail";
import { crossSection } from "./charts";
import { renderReport } from "./report";

function escHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

/** 장소 카드: 그 위치 자체를 잰 값이 아님을 분명히 */
function placeCard(p: Place, d: Dong, near: Near[], year: number, est: number | null = null, estLabel = "", prof: Profile | null = null, flags: string[] = []): HTMLElement {
  const el = document.createElement("section");
  el.className = "placecard";
  el.setAttribute("aria-label", `${p.name} 주변 소음`);
  const m = (x: number) => (x < 1000 ? `${Math.round(x / 10) * 10}m` : `${(x / 1000).toFixed(1)}km`);
  el.innerHTML = `
    <p class="pc-kicker">검색한 장소</p>
    <h2>${escHtml(p.name)}</h2>
    ${p.addr ? `<p class="hint">${escHtml(p.addr)}</p>` : ""}
    <div class="pc-row">
      ${est !== null ? `<div><span class="chip sm" style="background:${detailCss(est)}"></span><b>${fmt(est, 1, "dB")}</b>
        <p class="lbl">이 자리 <span class="est">추정</span> · ${escHtml(estLabel)}</p></div>` : ""}
      <div><span class="chip sm" style="background:${colorFor(d.l_night)}"></span><b>${fmt(d.l_night, 1, "dB")}</b>
        <p class="lbl">${escHtml(d.gu)} ${escHtml(d.name)} 대표값 · ${year}년 밤</p></div>
      ${near[0] ? `<div><span class="chip sm" style="background:${colorFor(near[0].s.l_night)}"></span><b>${fmt(near[0].s.l_night, 1, "dB")}</b>
        <p class="lbl">가장 가까운 센서 · ${m(near[0].d)}</p></div>` : ""}
    </div>
    ${near.length ? `<ol class="pc-near">${near.map((n) => `<li>센서 ${n.s.sn} · ${m(n.d)} · ${escHtml(n.s.rgn_ko)} · 밤 <b>${fmt(n.s.l_night, 1, "dB")}</b></li>`).join("")}</ol>`
                  : `<p class="hint">2km 안에 쓸 수 있는 센서가 없습니다.</p>`}
    ${flags.length ? `<ul class="pc-flags" aria-label="이 자리 주변의 소음 요인">${flags.map((f) => `<li>${escHtml(f)}</li>`).join("")}</ul>` : ""}
    ${prof ? `<h3 class="pc-h">큰길에서 이 자리까지 <span class="est">추정</span></h3><div class="chart" data-x="xsec"></div>
      <p class="hint">${prof.hereM === 0 ? "이 자리가 주변 250m 안에서 가장 시끄러운 쪽입니다." : `주변에서 가장 시끄러운 쪽(${prof.peakDb.toFixed(1)}dB)에서 <b>${prof.hereM}m</b> 들어온 자리입니다. 차이 <b>${(prof.peakDb - prof.hereDb).toFixed(1)}dB</b>.`}</p>` : ""}
    ${est !== null ? `<p class="hint"><b>이 자리 추정</b>은 주변 도로(차로 수·거리), 철도시설, 음식점·술집 밀집, 도로와 사이에 선 건물로 계산한 값입니다. 층수와 창문 방향은 반영하지 못합니다.</p>` : ""}
    <p class="hint">이 건물 자체를 잰 값이 아닙니다. 지도에 점선으로 이은 <b>가까운 길가 센서</b>의 밤 소음과, 이 장소가 속한 <b>동네 대표값</b>입니다. 센서와 건물 사이 거리·도로 방향에 따라 실제와 다를 수 있습니다.</p>`;
  if (prof) crossSection(el.querySelector<HTMLElement>('[data-x="xsec"]')!, prof, detailCss);
  return el;
}

// 번들러가 워커 파일을 옮기므로 위치를 직접 알려준다
maplibregl.setWorkerUrl(workerUrl);

// 배경지도: 브이월드(국토교통부) WMTS 타일. 키는 .env의 VITE_VWORLD_KEY (등록한 주소에서만 동작)
export const VW_KEY = String(import.meta.env.VITE_VWORLD_KEY ?? "").trim();
const VW_ATTR = '배경지도·항공사진 © <a href="https://www.vworld.kr" target="_blank" rel="noopener">브이월드</a>(국토교통부)';
const vw = (layer: string, ext: string) => ({
  type: "raster" as const, tileSize: 256, minzoom: 6, maxzoom: 19, attribution: VW_ATTR,
  tiles: [`https://api.vworld.kr/req/wmts/1.0.0/${VW_KEY}/${layer}/{z}/{y}/{x}.${ext}`],
});
type Basemap = "dark" | "light" | "sat";
const STYLE: StyleSpecification = {
  version: 8,
  sources: VW_KEY ? { "vw-dark": vw("midnight", "png"), "vw-light": vw("Base", "png"), "vw-sat": vw("Satellite", "jpeg"), "vw-label": vw("Hybrid", "png") } : {},
  layers: [
    { id: "bg", type: "background", paint: { "background-color": "#0b111c" } },
    ...(VW_KEY ? [
      // 배경지도는 회색조로 가라앉힌다: 지도 위에서 색을 띠는 것은 소음 값뿐이어야 파랑(조용함)이 배경과 섞이지 않는다
      { id: "vw-dark", type: "raster" as const, source: "vw-dark", paint: { "raster-saturation": -1, "raster-brightness-max": 0.62, "raster-contrast": 0.1 } },
      { id: "vw-light", type: "raster" as const, source: "vw-light", layout: { visibility: "none" as const }, paint: { "raster-saturation": -0.85 } },
      // 항공사진도 색을 빼고 어둡게: 건물·길 모양은 남고, 색은 소음 값만 띤다
      { id: "vw-sat", type: "raster" as const, source: "vw-sat", layout: { visibility: "none" as const }, paint: { "raster-saturation": -0.8, "raster-brightness-max": 0.7, "raster-contrast": 0.15 } },
    ] : []),
  ],
};

// '높음' 등급 단지 비율 0~100% (어두움 → 밝음)
const BLD_COLORS = ["#2f3b55", "#5b4f7a", "#8f6585", "#c98471", "#ffb38a"];
const BLD_LABELS = ["20% 미만", "20–40%", "40–60%", "60–80%", "80% 이상"];

interface State { hour: number | "all"; month: string | "all"; selected: string | null; three: boolean; playing: number | null }

export function renderMap(root: HTMLElement, data: Data, params: URLSearchParams, onCompare: (code: string) => void) {
  root.innerHTML = `
  <div class="mapgrid">
    <section class="mapwrap" aria-label="서울의 밤 지도">
      <div id="v3d" class="v3d" hidden>
        <iframe id="v3d-frame" title="브이월드 실사 3D 지도" allow="fullscreen"></iframe>
        <p class="v3d-chip" id="v3d-title" aria-live="polite"></p>
        <p class="v3d-note">실제 건물 모습은 브이월드(국토교통부) 3D 지도입니다. 선은 고른 동의 경계이고, 소음 값은 건물마다 잰 것이 아니라 동 대표값입니다.</p>
      </div>
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
        <div class="trange" role="group" aria-label="시간대">
          <button type="button" data-r="22,6" aria-pressed="true"><b>밤</b> 22~06시</button>
          <button type="button" data-r="6,22" aria-pressed="false"><b>낮</b> 06~22시</button>
        </div>
        <div class="row basemap" role="group" aria-label="지도 보기 방식">
          <button type="button" data-view="map" aria-pressed="true">배경지도</button>
          <button type="button" data-view="sat" aria-pressed="false">실사 2D</button>
          <button type="button" data-view="3d" aria-pressed="false">실사 3D</button>
        </div>
        <label class="lightopt"><input type="checkbox" id="bmlight" /> 배경지도를 밝게</label>
        <label class="opacity">색 진하기 <span id="oplabel">90%</span>
          <input type="range" id="op" min="0" max="100" step="5" value="90" aria-describedby="oplabel" />
        </label>
        <label class="lightopt"><input type="checkbox" id="tdet" checked /> 상세 지도 (10m 칸, <span class="est">추정</span>)</label>
        <p class="detnote" id="detnote" hidden></p>
        <div class="row toggles">
          <label><input type="checkbox" id="t3d" /> 3D 기둥(연출)</label>
          <label><input type="checkbox" id="tsen" /> 센서 위치</label>
          <label><input type="checkbox" id="tbld" /> 층간소음 위험(추정)</label>
        </div>
        <div class="legend" aria-label="색 범례">
          <div id="nlegend"><p>동네별 <span class="lwhen">밤</span> 소음 (dB) <span class="lyear"></span></p>
          <ul id="nlist"></ul>
          <p class="hint" id="nshift" hidden></p></div>
          <div id="dlegend" hidden><p>자리별 <span class="lwhen">밤</span> 소음 (dB) <span class="lyear"></span> <span class="est">추정</span></p>
          <div class="ramp" style="background:linear-gradient(90deg, ${DETAIL_STOPS.map(([v, c]) => `${c} ${((v - (DETAIL_MID - DETAIL_SPAN)) / (2 * DETAIL_SPAN)) * 100}%`).join(", ")})" role="img" id="dramp"></div>
          <div class="ramp-ticks" id="dticks"></div>
          <div class="ramp-ends"><span>조용함</span><span>중간</span><span>시끄러움</span></div>
          <p class="hint" id="dshift" hidden></p>
          <p class="hint">도로·철도·상가 밀집·건물 가림으로 계산한 값입니다. 센서 위치를 켜면 실제로 잰 자리를 볼 수 있습니다.</p></div>
          <div id="blegend" hidden><p>공동주택 중 '높음'(~2007년 사용승인) 단지 비율 <span class="est">추정</span></p>
          <ul>${BLD_COLORS.map((c, i) => `<li><span style="background:${c}"></span>${BLD_LABELS[i]}</li>`).join("")}
          <li><span style="background:${NODATA}"></span>단지 없음·연결 안 됨</li></ul></div>
        </div>
      </div>
    </section>
    <aside id="panel" class="panel" aria-live="polite">
      <div class="intro">
        <h2>서울의 밤</h2>
        <p id="intro-what">연도별 바깥 소음을 불러오는 중…</p>
        <p>서울 행정동 중앙값 <b id="intro-med">—</b> · WHO 야간 목표는 집 밖 연평균 <b>40dB</b>입니다.</p>
        <h3>가장 조용한 동 5곳</h3><ol id="top-q"></ol>
        <h3>가장 시끄러운 동 5곳</h3><ol id="top-l"></ol>
        <p class="hint">센서가 1개뿐인 동이 많습니다. 순위는 그 센서 위치의 영향을 받습니다.</p>
      </div>
    </aside>
  </div>`;

  const st: State = { hour: "all", month: "all", selected: params.get("d"), three: false, playing: null };
  // 연도별 보기: 선택한 해의 동 지표(years/{연도}.json)로 바꿔서 칠한다
  let year: number | null = null;
  let yearDongs: Record<string, Dong> | null = null;
  let yearInfos: YearInfo[] = [];
  const srcOf = (code: string): Dong | null => yearDongs?.[code] ?? null;
  // 시간대: [시작, 끝) 시각. 끝이 시작보다 작거나 같으면 자정을 넘는다. 기본 = 밤 22~06시
  let range: [number, number] = [22, 6];
  const rangeHours = ([a, b]: [number, number]) => {
    const out: number[] = [];
    for (let h = a; out.length < 24; h = (h + 1) % 24) { if (out.length && h === b % 24) break; out.push(h); }
    return out;
  };
  const isNight = () => range[0] === 22 && range[1] === 6;
  const rangeLabel = () => (isNight() ? "밤(22~06시)" : "낮(06~22시)");
  const periodLabel = () => {
    if (!year) return "";
    const y = yearInfos.find((x) => x.year === year);
    return y ? `${year}년 · ${y.start} ~ ${y.end} 밤 ${y.nights}일${y.partial ? " (일부 기간)" : ""}` : `${year}년`;
  };
  const map: MlMap = new maplibregl.Map({ container: "map", style: STYLE, center: [126.99, 37.56], zoom: 10.2, minZoom: 9, maxZoom: 18, attributionControl: { compact: true } });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
  if (import.meta.env.DEV) (window as any).__map = map; // 개발 중 디버그용

  const valueOf = (d: Dong | null): number | null => {
    if (!d) return null;
    if (isNight()) return d.l_night ?? null;          // 기본 밤 지표(이상치 제거·유효한 밤 기준)
    const hs = rangeHours(range).map((h) => d.by_hour24?.[h]).filter((v): v is number => v != null);
    if (!d.by_hour24 || hs.length < Math.ceil(rangeHours(range).length / 2)) return null;
    return 10 * Math.log10(hs.reduce((a, v) => a + 10 ** (v / 10), 0) / hs.length);   // 시각별 값의 에너지 평균
  };

  const top = () => {
    const vs = Object.keys(data.dongs).map((c) => ({ d: srcOf(c) ?? data.dongs[c], v: valueOf(srcOf(c)) })).filter((x) => x.v != null) as { d: Dong; v: number }[];
    vs.sort((a, b) => a.v - b.v);
    const med = vs.length ? vs[Math.floor(vs.length / 2)].v : null;
    const w = root.querySelector("#intro-what"), m = root.querySelector("#intro-med");
    if (w && year) w.innerHTML = `<b>${year}년</b> 서울 행정동 ${vs.length}곳의 <b>${rangeLabel()}</b> 바깥 소음(시간 평균)입니다. 동을 누르거나 위에서 검색하면 동네 리포트가 열립니다.`;
    if (m) m.textContent = fmt(med, 1, "dB");
    const li = (x: { d: Dong; v: number }) => `<li><button type="button" class="link" data-code="${x.d.code}">${x.d.gu} ${x.d.name}</button> ${x.v.toFixed(1)}dB <small>센서 ${x.d.n_sensors}</small></li>`;
    const q = root.querySelector("#top-q"), l = root.querySelector("#top-l");
    if (q) q.innerHTML = vs.slice(0, 5).map(li).join("");
    if (l) l.innerHTML = vs.slice(-5).reverse().map(li).join("");
    root.querySelectorAll<HTMLButtonElement>(".intro button[data-code]").forEach((b) => b.addEventListener("click", () => select(b.dataset.code!, true)));
  };

  // 낮에는 서울 전체가 밤보다 몇 dB 높다. 동네끼리 차이가 보이도록 색 기준을 그만큼(정수 dB) 옮기고 범례 숫자도 함께 바꾼다
  let dongShift = 0;
  const med = (a: number[]) => { const b = [...a].sort((x, y) => x - y); return b.length ? b[Math.floor(b.length / 2)] : 0; };
  const paint = () => {
    const codes = data.geo.features.map((f) => (f.properties as any).code as string);
    const vs = codes.map((c) => valueOf(srcOf(c)));
    const nights = codes.map((c) => srcOf(c)?.l_night).filter((v): v is number => v != null);
    dongShift = isNight() ? 0 : Math.round(med(vs.filter((v): v is number => v != null)) - med(nights));
    data.geo.features.forEach((f, i) => {
      const v = vs[i];
      map.setFeatureState({ source: "dongs", id: f.id as number }, { v: v ?? 0, c: (v ?? 0) - dongShift, has: v != null });
    });
    const lab = (i: number) => (i === 0 ? `${BREAKS[0] + dongShift} 미만` : i === BREAKS.length ? `${BREAKS[i - 1] + dongShift} 이상` : `${BREAKS[i - 1] + dongShift}–${BREAKS[i] + dongShift}`);
    root.querySelector("#nlist")!.innerHTML = COLORS.map((c, i) => `<li><span style="background:${c}"></span>${lab(i)}</li>`).join("") + `<li><span class="nodata"></span>데이터 없음</li>`;
    const ns = root.querySelector<HTMLElement>("#nshift")!;
    ns.hidden = dongShift === 0;
    ns.innerHTML = `낮은 서울 전체가 밤보다 약 <b>${dongShift}dB</b> 높아, 동네끼리 차이가 보이도록 색 기준을 그만큼 옮겼습니다.`;
    root.querySelectorAll<HTMLElement>(".lwhen").forEach((e) => (e.textContent = isNight() ? "밤" : "낮"));
    root.querySelectorAll<HTMLElement>(".lyear").forEach((e) => (e.textContent = year ? `· ${year}년` : ""));
    top();
  };

  const panel = root.querySelector<HTMLElement>("#panel")!;
  let pendingFly = false;
  const select = (code: string, fly = false) => {
    const d = data.dongs[code];
    if (!d) return;
    if (!year) { st.selected = code; pendingFly = pendingFly || fly; return; }   // 연도 자료가 오면 refresh()가 이어서 처리
    st.selected = code;
    history.replaceState(null, "", `#/map?d=${code}`);
    map.setFilter("sel", ["==", ["get", "code"], code]);
    const fp = document.getElementById("foot-period");
    if (fp) fp.textContent = periodLabel();
    const yd = yearDongs?.[code];
    const shown = { ...d, ...(yd ?? { l_night: null, pattern: undefined }), report: null } as Dong;
    renderReport(panel, data, shown, { onCompare, year, periodLabel: periodLabel(),
      range: isNight() ? undefined : { label: rangeLabel(), value: valueOf(yd ?? null) } });
    if (view3D()) { v3dCenter = null; setTimeout(() => sync3D(fly), fly ? 50 : 0); }
    if (fly) {
      const f = data.geo.features.find((x) => (x.properties as any).code === code);
      if (f) {
        const b = new maplibregl.LngLatBounds();
        const walk = (c: any) => (typeof c[0] === "number" ? b.extend(c as [number, number]) : c.forEach(walk));
        walk((f.geometry as any).coordinates);
        map.fitBounds(b, { padding: 60, maxZoom: 14, duration: view3D() ? 0 : 600 });
      }
    }
  };

  // 배경 타일을 다 받을 때까지 기다리지 않고, 스타일만 준비되면 바로 색칠
  let styleReady = false;
  map.once("style.load", () => {
    styleReady = true;
    map.addSource("dongs", { type: "geojson", data: data.geo });
    const color: any = ["case", ["boolean", ["feature-state", "has"], false], step(["feature-state", "c"]), NODATA];
    map.addLayer({ id: "fill", type: "fill", source: "dongs", paint: { "fill-color": color, "fill-opacity": ["case", ["boolean", ["feature-state", "has"], false], 0.8, 0] } });
    map.addLayer({ id: "ext", type: "fill-extrusion", source: "dongs", layout: { visibility: "none" },
      paint: { "fill-extrusion-color": color, "fill-extrusion-opacity": 0.9,
        "fill-extrusion-height": ["case", ["boolean", ["feature-state", "has"], false], ["*", ["max", 0, ["-", ["feature-state", "v"], 33]], 120], 0] } });
    map.addLayer({ id: "line", type: "line", source: "dongs", paint: { "line-color": "#0b111c", "line-width": 0.6 } });
    // 지명·도로 이름: 색칠에 가려지지 않게 맨 위에 다시 얹는다 (브이월드 Hybrid = 투명 바탕의 지명·도로)
    if (VW_KEY) map.addLayer({ id: "vw-label", type: "raster", source: "vw-label", paint: { "raster-opacity": 0.85 } });
    map.addLayer({ id: "sel", type: "line", source: "dongs", filter: ["==", ["get", "code"], ""], paint: { "line-color": "#ffffff", "line-width": 2.5 } });
    paint();
    showDetail();
    if (lastPlace) showPlace(lastPlace);
    else if (st.selected) select(st.selected, true);

    const pop = new maplibregl.Popup({ closeButton: false, closeOnClick: false, className: "tip" });
    map.on("mousemove", "fill", (e) => {
      const f = e.features?.[0]; if (!f) return;
      const d = data.dongs[(f.properties as any).code];
      map.getCanvas().style.cursor = "pointer";
      const est = detailOn() && nmap ? nmap.valueAt(e.lngLat.lng, e.lngLat.lat) : null;
      pop.setLngLat(e.lngLat).setHTML(`${est !== null ? `이 자리 추정 <b>${est.toFixed(1)}dB</b><br>` : ""}<b>${d.gu} ${d.name}</b> ${est !== null ? "동네 값 " : "<br>"}${fmt(valueOf(srcOf(d.code)), 1, "dB")}${year ? ` <small>(${year}년)</small>` : ""}`).addTo(map);
    });
    map.on("mouseleave", "fill", () => { map.getCanvas().style.cursor = ""; pop.remove(); });
    map.on("click", "fill", (e) => {
      const f = e.features?.[0]; if (!f) return;
      // 상세 지도가 켜져 있으면 누른 자리를 바로 살펴본다 (끄면 예전처럼 동네만 고름)
      if (detailOn()) showPlace({ name: "지도에서 고른 자리", addr: `${data.dongs[(f.properties as any).code].gu} ${data.dongs[(f.properties as any).code].name}`, lon: e.lngLat.lng, lat: e.lngLat.lat }, false);
      else select((f.properties as any).code);
    });
  });

  // 컨트롤: 연도 + 시간대
  const presets = [...root.querySelectorAll<HTMLButtonElement>(".trange button")];
  const refresh = () => {
    paint();
    const fp = document.getElementById("foot-period");
    if (fp) fp.textContent = periodLabel();
    if (lastPlace) showPlace(lastPlace, false);      // 장소 카드도 고른 연도 값으로 다시 그림
    else if (st.selected) { const f = pendingFly; pendingFly = false; select(st.selected, f); }
    showSensors();
  };
  const setRange = (a: number, b: number) => {
    range = [a, b];
    presets.forEach((p) => p.setAttribute("aria-pressed", String(p.dataset.r === `${a},${b}`)));
    refresh();
    showDetail();
  };
  presets.forEach((p) => p.addEventListener("click", () => { const [a, b] = p.dataset.r!.split(",").map(Number); setRange(a, b); }));
  const loadYearData = async (y: number) => {
    year = y;
    yearDongs = await loadYear(y);
    if (styleReady) refresh();
    showDetail();
  };
  // 화면에 쓰는 해는 하나: 가장 최근에 끝난 해 (해가 바뀌어 새 1년치가 들어오면 자료 쪽에서 자동으로 바뀐다)
  loadYearsIndex().then((ys) => {
    yearInfos = ys;
    const want = ys[ys.length - 1]?.year;
    if (want) loadYearData(want);
  });
  const stop = () => {};
  // 배경 지도 전환 + 색 진하기
  const viewButtons = [...root.querySelectorAll<HTMLButtonElement>(".basemap button")];
  // 상세 추정 지도 (켜면 동네 색칠 대신 10m 칸 추정값을 보여 준다. 동네를 누르는 동작은 그대로)
  const tdet = root.querySelector<HTMLInputElement>("#tdet")!;
  let nmap: NoiseMap | null = null;
  // 상세 지도는 한 해의 밤(22~06시)만 계산돼 있다. 다른 연도·시간대를 고르면 동네 색칠(측정값)로 돌아간다
  const detailFits = () => !!nmap && year === nmap.meta.year && (isNight() || nmap.hasDay);
  const detailWhen = () => (isNight() ? "밤" : "낮");
  let drawn = "";   // 지금 상세 지도에 그려진 시간대
  const detailOn = () => tdet.checked && detailFits();
  const showDetail = async () => {
    if (tdet.checked && !nmap) {
      nmap = await loadNoiseMap();
      if (!nmap) { tdet.checked = false; tdet.disabled = true; tdet.parentElement!.title = "상세 지도 파일이 없습니다"; }
    }
    if (nmap && styleReady && !map.getSource("detail")) {
      map.addSource("detail", { type: "canvas", canvas: nmap.canvas, coordinates: nmap.coords, animate: false } as any);
      map.addLayer({ id: "detail", type: "raster", source: "detail", paint: { "raster-opacity": 0.9, "raster-fade-duration": 0 } }, "line");
    }
    const note = root.querySelector<HTMLElement>("#detnote")!;
    if (nmap && detailOn() && drawn !== range.join()) {
      // 고른 시간대의 시각들로 다시 계산해 그린다 (밤 22~06시는 기본 밤 지도)
      const want = range.join();
      const ok = await nmap.setMode(isNight() ? "night" : "day");
      if (want !== range.join()) return;               // 그 사이 다시 바꿨으면 그쪽 호출이 마무리한다
      if (ok) {
        drawn = want;
        const src: any = map.getSource("detail");
        if (src?.play) { src.play(); requestAnimationFrame(() => src.pause()); }
        map.triggerRepaint();
        const sh = nmap.shift(), lo = DETAIL_MID - DETAIL_SPAN + sh;
        root.querySelector<HTMLElement>("#dticks")!.innerHTML = [0, 1, 2, 3, 4].map((i) => `<span>${lo + i * DETAIL_SPAN / 2}${i === 0 ? " 이하" : i === 4 ? " 이상" : ""}</span>`).join("");
        root.querySelector<HTMLElement>("#dramp")!.setAttribute("aria-label", `${lo}dB(파랑, 조용함)에서 가운데 ${lo + DETAIL_SPAN}dB(회색)를 지나 ${lo + 2 * DETAIL_SPAN}dB(노랑, 시끄러움)까지 이어지는 색`);
        const ds = root.querySelector<HTMLElement>("#dshift")!;
        ds.hidden = sh === 0;
        ds.innerHTML = `낮은 서울 전체가 밤보다 약 <b>${sh}dB</b> 높아, 자리별 차이가 보이도록 색 기준을 그만큼 옮겼습니다. 같은 색이라도 밤 지도와 dB가 다릅니다.`;
      }
    }
    if (map.getLayer("detail")) map.setLayoutProperty("detail", "visibility", detailOn() ? "visible" : "none");
    note.hidden = !(tdet.checked && nmap && !detailFits());
    if (nmap) note.textContent = "이 시간대의 상세 지도가 아직 없어 동네 단위 측정값으로 보여 드립니다.";
    const bld = root.querySelector<HTMLInputElement>("#tbld")!.checked;
    root.querySelector<HTMLElement>("#dlegend")!.hidden = !detailOn() || bld;
    root.querySelector<HTMLElement>("#nlegend")!.hidden = detailOn() || bld;
    applyOpacity();
    if (lastPlace) showPlace(lastPlace, false);
  };
  tdet.addEventListener("change", showDetail);

  const bmLight = root.querySelector<HTMLInputElement>("#bmlight")!;
  const op = root.querySelector<HTMLInputElement>("#op")!;
  const opLabel = root.querySelector<HTMLElement>("#oplabel")!;
  const applyOpacity = () => {
    const v = +op.value / 100;
    const off = v === 0; // 0% = 소음 색 없이 배경 지도만
    opLabel.textContent = off ? "0% (색 끔 · 지도만 보기)" : `${op.value}%`;
    if (!map.getLayer("fill")) return;
    map.setPaintProperty("fill", "fill-opacity", detailOn() ? 0 : ["case", ["boolean", ["feature-state", "has"], false], v, 0]);
    if (map.getLayer("detail")) map.setPaintProperty("detail", "raster-opacity", v);
    map.setPaintProperty("ext", "fill-extrusion-opacity", off ? 0 : Math.min(1, v + 0.1));
    if (map.getLayer("bfill")) map.setPaintProperty("bfill", "fill-opacity", off ? 0 : Math.min(1, v + 0.05));
    root.querySelector<HTMLElement>(".legend")!.classList.toggle("dim", off);
  };
  const setBasemap = (mode: Basemap) => {
    markView(mode === "sat" ? "sat" : "map");
    if (!map.getLayer("vw-dark")) return;
    for (const m of ["dark", "light", "sat"] as Basemap[]) map.setLayoutProperty(`vw-${m}`, "visibility", m === mode ? "visible" : "none");
    // 밝은 지도·항공사진 위에서는 동 경계를 눈에 띄게, 색은 조금 옅게 해서 바탕이 보이게
    map.setPaintProperty("line", "line-color", mode === "sat" ? "#ffffff" : mode === "light" ? "#3a4763" : "#0b111c");
    map.setPaintProperty("line", "line-opacity", mode === "sat" ? 0.55 : 1);
    op.value = mode === "sat" ? "75" : mode === "light" ? "75" : "90";
    applyOpacity();
  };
  // 보기 방식 3가지: 배경지도 / 실사 2D(항공사진) / 실사 3D(브이월드 3D 화면)
  const markView = (v: "map" | "sat" | "3d") => {
    viewButtons.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.view === v)));
    bmLight.disabled = v !== "map";
  };
  const setView = (v: string) => {
    if (v === "3d") { openReal3D(); return; }
    closeReal3D();
    setBasemap(v === "sat" ? "sat" : bmLight.checked ? "light" : "dark");
  };
  root.querySelectorAll<HTMLButtonElement>("[data-view]").forEach((b) => b.addEventListener("click", () => setView(b.dataset.view!)));
  bmLight.addEventListener("change", () => setBasemap(bmLight.checked ? "light" : "dark"));
  op.addEventListener("input", applyOpacity);

  // 3D 기둥(동 전체를 한 덩어리로 세우는 연출용)
  const t3d = root.querySelector<HTMLInputElement>("#t3d")!;
  t3d.addEventListener("change", () => {
    const on = t3d.checked;
    map.setLayoutProperty("ext", "visibility", on ? "visible" : "none");
    map.setLayoutProperty("fill", "visibility", on ? "none" : "visible");
    map.easeTo({ pitch: on ? 55 : 0, bearing: on ? -15 : 0, duration: 700 });
  });
  // 실사 3D: 브이월드 3D 지도를 같은 위치로 띄운다 (별도 화면)
  const v3d = root.querySelector<HTMLElement>("#v3d")!;
  const v3dFrame = root.querySelector<HTMLIFrameElement>("#v3d-frame")!;
  // 같은 지도 자리에 3D를 겹쳐 보여 준다. 한 번 불러온 3D는 켜 둔 채 위치·동만 바꿔서 바로 전환되게 한다
  let v3dLoaded = false;
  let v3dCenter: { lon: number; lat: number } | null = null;   // 3D에서 보고 있던 곳 (2D로 돌아올 때 맞춤)
  const view3D = () => !v3d.hidden;
  const sync3D = (move = true) => {
    const c = marker ? marker.getLngLat() : map.getCenter();
    const d = st.selected ? data.dongs[st.selected] : null;
    const v = d ? valueOf(srcOf(d.code)) : null;
    const showDong = !!d && map.getZoom() >= 12.5;          // 동을 보고 있을 때만 경계선을 함께 그린다
    const height = Math.max(300, Math.min(30000, 700 * 2 ** (15 - map.getZoom())));
    const msg = { type: "jamjal-3d", move, lon: +c.lng.toFixed(6), lat: +c.lat.toFixed(6), height: Math.round(height),
      code: showDong ? d!.code : "", color: showDong && v != null ? colorFor(v) : "#ffffff" };
    root.querySelector("#v3d-title")!.textContent = d ? `${d.gu} ${d.name}${v != null ? ` · ${year}년 ${rangeLabel()} ${v.toFixed(1)}dB` : " · 데이터 없음"}` : "";
    if (!v3dLoaded) {
      const q = new URLSearchParams(Object.entries(msg).filter(([k]) => k !== "type" && k !== "move").map(([k, x]) => [k, String(x)]));
      v3dFrame.src = `${import.meta.env.BASE_URL}vworld3d.html?${q}`;
      v3dLoaded = true;
    } else v3dFrame.contentWindow?.postMessage(msg, location.origin);
  };
  const openReal3D = () => {
    if (!VW_KEY) { alert("브이월드 인증키(VITE_VWORLD_KEY)가 없어 실사 3D를 열 수 없습니다."); return; }
    v3d.hidden = false;
    markView("3d");
    sync3D();
  };
  const closeReal3D = () => {
    if (v3d.hidden) return;
    v3d.hidden = true;
    if (v3dCenter) map.jumpTo({ center: [v3dCenter.lon, v3dCenter.lat] });   // 3D에서 옮겨 간 곳을 2D에서도 이어서 봄
  };
  const on3DMessage = (e: MessageEvent) => {
    if (e.origin !== location.origin || e.data?.type !== "jamjal-3d-pos") return;
    if (Number.isFinite(e.data.lon) && Number.isFinite(e.data.lat)) v3dCenter = { lon: e.data.lon, lat: e.data.lat };
  };
  window.addEventListener("message", on3DMessage);
  const tsen = root.querySelector<HTMLInputElement>("#tsen")!;
  let sensorYear: number | null = null;
  const showSensors = async () => {
    if (!year) return;
    if (tsen.checked && sensorYear !== year) {
      const sy = year;
      const list = await loadSensors(sy);
      const fc: any = { type: "FeatureCollection", features: list.map((x) => ({ type: "Feature", properties: { ...x }, geometry: { type: "Point", coordinates: [x.lon, x.lat] } })) };
      if (!map.getSource("sensors")) {
        map.addSource("sensors", { type: "geojson", data: fc });
        map.addLayer({ id: "sensors", type: "circle", source: "sensors", paint: {
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 10, 2, 15, 6],
          "circle-color": ["case", ["get", "used"], "#ffffff", "#8a93a6"], "circle-stroke-color": "#0b111c", "circle-stroke-width": 1 } });
        map.on("click", "sensors", (ev) => {
          const p: any = ev.features?.[0]?.properties; if (!p) return;
          new maplibregl.Popup().setLngLat(ev.lngLat).setHTML(`<b>센서 ${p.sn}</b><br>${p.rgn_ko}<br>${year}년 밤 ${p.l_night ?? "—"}dB<br>${p.used ? "동네 대표값에 사용" : p.noise_ok ? "대표값에 쓰지 않음(공원·도로변 등)" : "제외(결측·고장 의심)"}`).addTo(map);
        });
      } else (map.getSource("sensors") as maplibregl.GeoJSONSource).setData(fc);
      sensorYear = sy;
    }
    if (map.getLayer("sensors")) map.setLayoutProperty("sensors", "visibility", tsen.checked ? "visible" : "none");
  };
  tsen.addEventListener("change", showSensors);
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
    root.querySelector<HTMLElement>("#nlegend")!.hidden = el.checked || detailOn();
    root.querySelector<HTMLElement>("#dlegend")!.hidden = el.checked || !detailOn();
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
  let lastPlace: Place | null = null;
  const clearPlace = () => {
    lastPlace = null;
    marker?.remove(); marker = null;
    (map.getSource("near") as maplibregl.GeoJSONSource | undefined)?.setData({ type: "FeatureCollection", features: [] });
  };
  const showPlace = async (p: Place, fly = true) => {
    const code = dongAt(data, p.lon, p.lat);
    if (!code) return;
    if (!year) { lastPlace = p; return; }          // 연도 자료가 오면 refresh()가 다시 부른다
    const sensors = await loadSensors(year);
    const near = nearestSensors(sensors, p.lon, p.lat);
    clearPlace();
    lastPlace = p;
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
    if (fly && view3D()) { map.jumpTo({ center: [p.lon, p.lat], zoom: 15 }); sync3D(true); }
    else if (fly) map.flyTo({ center: [p.lon, p.lat], zoom: 15, duration: 700 });
    history.replaceState(null, "", `#/map?d=${code}&p=${p.lat.toFixed(5)},${p.lon.toFixed(5)}&n=${encodeURIComponent(p.name)}`);
    const yd = { ...data.dongs[code], ...(yearDongs?.[code] ?? { l_night: null }) } as Dong;
    panel.querySelector(".placecard")?.remove();
    const on = detailOn();
    const flags = on ? await nmap!.flagsAt(p.lon, p.lat) : [];
    panel.querySelector(".placecard")?.remove();
    panel.prepend(placeCard(p, yd, near, year, on ? nmap!.valueAt(p.lon, p.lat) : null, `${nmap?.meta.year ?? ""}년 ${detailWhen()}`, on ? nmap!.profile(p.lon, p.lat) : null, flags));
  };

  // 공유한 주소로 들어오면 장소 다시 표시
  const pp = params.get("p");
  if (pp) {
    const [lat, lon] = pp.split(",").map(Number);
    const pl: Place = { name: params.get("n") ?? "선택한 장소", addr: "", lat, lon };
    showPlace(pl);
  }
  return () => { stop(); window.removeEventListener("message", on3DMessage); map.remove(); };
}
