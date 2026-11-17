import * as maplibregl from "maplibre-gl";
import type { Map as MlMap, StyleSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import { type Data } from "./data";
import { DONG_COLORS, type DongShares, FEEL, type HeatInfo, WORDS, dongGrade, heatUrl, hourLabel, loadDongShares, loadHeat, loadLevels, pixelIndex } from "./heat";
import { type Place, dongAt, searchPlaces } from "./place";
import { sortedDongs } from "./data";

function escHtml(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
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

type View = "heat" | "dong";

/** 지도 화면. 보기 방식 두 가지: 히트맵(자리별) / 동네별. 소음 자료는 같은 것을 쓴다(pipeline/heatmap.py). */
export function renderMap(root: HTMLElement, data: Data, params: URLSearchParams) {
  root.innerHTML = `
  <div class="mapgrid svc">
    <section class="mapwrap" aria-label="서울 소음 지도">
      <div id="v3d" class="v3d" hidden>
        <iframe id="v3d-frame" title="브이월드 실사 3D 지도" allow="fullscreen"></iframe>
        <p class="v3d-chip" id="v3d-title" aria-live="polite"></p>
        <p class="v3d-note">실제 건물 모습은 브이월드(국토교통부) 3D 지도입니다. 소음은 건물마다 잰 것이 아니라 추정한 값입니다.</p>
      </div>
      <p class="v3d-loading" id="v3d-loading" role="status" hidden>실사 3D로 넘어가는 중…</p>
      <div id="map" role="application" aria-label="서울 소음 지도. 보기 방식과 시간대를 바꿀 수 있고, 지도를 누르면 그 자리의 소음이 나옵니다."></div>
      <div class="tbar">
        <form class="search" id="qform" role="search">
          <label for="q" class="sr">동네·건물·장소 찾기</label>
          <div class="qrow">
            <input list="dong-list" id="q" placeholder="주소, 동네, 건물, 역 이름으로 찾기" autocomplete="off" />
            <button type="submit">찾기</button>
          </div>
          <p id="qmsg" class="qmsg" aria-live="polite"></p>
          <ul id="qres" class="qres"></ul>
        </form>
        <datalist id="dong-list">${sortedDongs(data).map((d) => `<option value="${d.gu} ${d.name}"></option>`).join("")}</datalist>
        <div class="pills">
          <div class="vswitch" role="group" aria-label="보기 방식">
            <button type="button" data-v="heat" aria-pressed="true">히트맵</button>
            <button type="button" data-v="dong" aria-pressed="false">동네별</button>
          </div>
          <div class="trange" role="group" aria-label="시간대">
            <button type="button" data-tr="night" aria-pressed="true">밤</button>
            <button type="button" data-tr="day" aria-pressed="false">낮</button>
          </div>
          <details class="more">
            <summary>시각·지도 설정</summary>
            <div class="morebody">
              <div class="tslider sub">
                <div class="ts-head">
                  <p><b id="tlabel" aria-live="polite">밤 11시</b></p>
                  <button type="button" id="tplay" aria-pressed="false">▶ 하루 재생</button>
                </div>
                <input type="range" id="thour" min="0" max="23" step="1" value="23" aria-label="시각 (0시~23시)" />
                <div class="ts-ticks" aria-hidden="true"><span>0시</span><span>6시</span><span>12시</span><span>18시</span><span>23시</span></div>
              </div>
              <div class="row basemap" role="group" aria-label="지도 바탕">
                <button type="button" data-view="map" aria-pressed="true">배경지도</button>
                <button type="button" data-view="sat" aria-pressed="false">실사 2D</button>
                <button type="button" data-view="3d" aria-pressed="false">실사 3D</button>
              </div>
              <label class="lightopt"><input type="checkbox" id="bmlight" checked /> 배경지도를 밝게</label>
              <label class="opacity">색 진하기 <span id="oplabel">72%</span>
                <input type="range" id="op" min="0" max="100" step="5" value="72" aria-describedby="oplabel" />
              </label>
            </div>
          </details>
        </div>
      </div>
      <p class="maphint" id="maphint" hidden><span></span><button type="button" aria-label="안내 닫기">×</button></p>
      <div class="maplegend">
        <div class="legend" aria-label="색 설명">
          <p><span id="lwhen">밤</span>의 집 밖 소음 <small class="est">추정</small></p>
          <div id="lbody"></div>
        </div>
      </div>
      <aside id="panel" class="panel sheet" aria-live="polite"><div class="intro"><p class="loading">불러오는 중…</p></div></aside>
    </section>
  </div>`;

  // ── 상태 ──
  let heat: HeatInfo | null = null;
  let shares: DongShares | null = null;
  const lv: Record<string, Uint8Array | undefined> = {};       // 그림 이름 → 자리별 단계
  let view: View = params.get("v") === "dong" ? "dong" : "heat";
  const t0 = params.get("t") ?? "night";
  let sel: "night" | "day" | null = t0 === "night" || t0 === "day" ? t0 : null;   // null 이면 시각 막대에서 고른 시각
  let hour = sel ? 23 : Math.min(23, Math.max(0, Number(t0.replace("h", "")) || 0));
  let pick: { lon: number; lat: number } | null = null;         // 히트맵에서 누른 자리
  let dongSel: string | null = params.get("d");                 // 고른 동네
  let playing = 0;
  let shown = "";
  let lineBase = "#5b667d";
  const key = () => sel ?? `h${hour}`;
  const when = () => (sel === "night" ? "밤" : sel === "day" ? "낮" : hourLabel(hour));
  const dongName = (code: string | null) => { const d = code ? data.dongs[code] : null; return d ? `${d.gu} ${d.name}` : "서울"; };
  const title3D = () => (dongSel ? `${dongName(dongSel)} · ${when()}` : "");
  const writeUrl = () => history.replaceState(null, "", `#/map?v=${view}&t=${key()}${view === "dong" && dongSel ? `&d=${dongSel}` : ""}`);

  const map: MlMap = new maplibregl.Map({ container: "map", style: STYLE, center: [126.99, 37.56], zoom: 10.6, minZoom: 9, maxZoom: 18, attributionControl: { compact: true } });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
  if (import.meta.env.DEV) (window as any).__map = map; // 개발 중 디버그용

  const panel = root.querySelector<HTMLElement>("#panel")!;
  const slider = root.querySelector<HTMLInputElement>("#thour")!;
  const trBtns = [...root.querySelectorAll<HTMLButtonElement>("[data-tr]")];
  const vBtns = [...root.querySelectorAll<HTMLButtonElement>("[data-v]")];
  slider.value = String(hour);
  let pin: maplibregl.Marker | null = null;
  const coords = (): [[number, number], [number, number], [number, number], [number, number]] => {
    const b = heat!.bounds; return [[b.west, b.north], [b.east, b.north], [b.east, b.south], [b.west, b.south]];
  };
  const needLevels = (k: string) => {
    if (!heat || k in lv || !heat.frames[k]) return;
    lv[k] = undefined;
    loadLevels(heat, k).then((a) => { lv[k] = a; if (view === "heat") renderPanel(); }).catch(() => { delete lv[k]; });
  };
  const strip = (cells: { color: string | null; label: string }[]) => `
    <div class="daystrip heat" role="group" aria-label="0시부터 23시까지. 누르면 그 시각의 지도로 바뀝니다.">${cells.map((c, h) =>
      `<button type="button" data-h="${h}" class="${sel === null && h === hour ? "on" : ""} ${c.color ? "" : "none"}" style="background:${c.color ?? "transparent"}" aria-label="${hourLabel(h)} ${c.label}"></button>`).join("")}</div>
    <div class="ts-ticks" aria-hidden="true"><span>0시</span><span>6시</span><span>12시</span><span>18시</span><span>23시</span></div>`;
  const wireCard = (close: () => void) => {
    panel.querySelectorAll<HTMLButtonElement>(".daystrip button").forEach((b) => b.addEventListener("click", () => setHour(+b.dataset.h!)));
    panel.querySelector("#cardclose")?.addEventListener("click", close);
  };

  // ── 오른쪽 안내 칸 ──
  const intro = (note = "") => {
    panel.innerHTML = `
      <div class="intro simple">
        <h2>이 집, 밤에 조용할까요?</h2>
        ${note ? `<p class="plain">${note}</p>` : ""}
        <p class="lead">주소를 찾거나 ${view === "heat" ? "지도를 눌러 보세요." : "동네를 눌러 보세요."} <b>색이 진할수록</b> 시끄러운 곳입니다.</p>
        <p class="hint">집 밖 소음을 추정한 값이며, 집 안 소음과는 다릅니다.</p>
      </div>`;
  };
  const heatCard = (): boolean => {
    if (!heat || !pick) return false;
    const i = pixelIndex(heat, pick.lon, pick.lat);
    const at = (k: string) => (i == null ? 255 : lv[k]?.[i]);
    const cur = at(shown);
    if (cur === 255) { intro("누른 자리는 서울 밖이거나 값이 없는 곳입니다."); return true; }
    if (cur == null) { intro("불러오는 중입니다…"); return true; }
    for (let h = 0; h < 24; h++) needLevels(`h${h}`);
    const day = Array.from({ length: 24 }, (_, h) => at(`h${h}`));
    const full = day.every((v) => v != null && v !== 255);
    panel.innerHTML = `
      <section class="cellcard simple" aria-label="누른 자리의 소음">
        <p class="pc-kicker">${escHtml(dongName(dongAt(data, pick.lon, pick.lat)))} · ${when()}</p>
        <h2><span class="heatdot ${cur === 0 ? "none" : ""}" style="background:${cur === 0 ? "transparent" : heat.colors[cur]}"></span><b>${WORDS[cur]}</b><small>${heat.scores[cur]}점</small></h2>
        <p class="plain">${FEEL[cur]}</p>
        ${full ? `<h3>이 자리의 하루</h3>${strip(day.map((v) => ({ color: v === 0 ? null : heat!.colors[v as number], label: WORDS[v as number] })))}` : ""}
        <p class="hint">집 밖 소음을 주변 센서와 도로 등으로 추정한 값입니다. 집 안 소음과는 다릅니다.</p>
        <button type="button" class="link" id="cardclose">← 닫기</button>
      </section>`;
    wireCard(() => { pick = null; pin?.remove(); pin = null; renderPanel(); });
    return true;
  };
  const dongCard = (): boolean => {
    if (!heat || !shares || !dongSel || !data.dongs[dongSel]) return false;
    const s = shares[key()]?.[dongSel];
    if (!s) { intro(`<b>${escHtml(dongName(dongSel))}</b>은(는) 값을 낼 수 있는 자리가 없습니다.`); return true; }
    const gradeAt = (k: string, x: number[]) => dongGrade(x[3], heat!.frames[k].cuts);
    const b = gradeAt(shown, s);
    const pct = (x: number) => Math.round(x * 100);
    const day = Array.from({ length: 24 }, (_, h) => shares![`h${h}`]?.[dongSel!]);
    panel.innerHTML = `
      <section class="cellcard simple" aria-label="고른 동네의 소음">
        <p class="pc-kicker">${escHtml(dongName(dongSel))} · ${when()}</p>
        <h2><span class="heatdot" style="background:${DONG_COLORS[b]}"></span><b>${WORDS[b]}</b><small>${heat.scores[b]}점</small></h2>
        <p class="plain">${FEEL[b]}</p>
        <h3>이 동네 안을 나눠 보면</h3>
        <div class="sharebar" role="img" aria-label="조용 ${pct(s[0])}%, 보통 ${pct(s[1])}%, 시끄러움 ${pct(s[2])}%">
          <span class="q" style="flex:${s[0]}"></span><span style="flex:${s[1]};background:${heat.colors[1]}"></span><span style="flex:${s[2]};background:${heat.colors[2]}"></span>
        </div>
        <p class="sharekey"><span>조용 ${pct(s[0])}%</span><span>보통 ${pct(s[1])}%</span><span>시끄러움 ${pct(s[2])}%</span></p>
        ${day.every(Boolean) ? `<h3>이 동네의 하루</h3>${strip(day.map((x: number[] | undefined, hh: number) => { const k = gradeAt(`h${hh}`, x!); return { color: k === 0 ? null : heat!.colors[k], label: WORDS[k] }; }))}` : ""}
        <p class="hint">같은 동네 안에서도 큰길가와 안쪽은 다릅니다. 집 밖 소음을 추정한 값이며, 집 안 소음과는 다릅니다.</p>
        <button type="button" class="link" id="toheat">이 동네를 히트맵으로 자세히 보기 →</button>
        <button type="button" class="link" id="cardclose">← 닫기</button>
      </section>`;
    wireCard(() => selectDong(null));
    panel.querySelector("#toheat")!.addEventListener("click", () => { setMode("heat"); fitDong(dongSel!); });
    return true;
  };
  const renderPanel = (note = "") => {
    if (view === "heat" ? heatCard() : dongCard()) return;
    intro(note);
  };

  // ── 색칠 ──
  const styleLines = () => {
    if (!map.getLayer("line")) return;
    const d = view === "dong";
    map.setPaintProperty("line", "line-color", d ? "#ffffff" : lineBase);
    map.setPaintProperty("line", "line-width", d ? 0.9 : 0.5);
    map.setPaintProperty("line", "line-opacity", d ? 0.9 : 0.3);
  };
  const paint = () => {
    root.querySelector("#tlabel")!.textContent = hourLabel(hour);
    root.querySelector("#lwhen")!.textContent = when();
    trBtns.forEach((x) => x.setAttribute("aria-pressed", String(x.dataset.tr === sel)));
    vBtns.forEach((x) => x.setAttribute("aria-pressed", String(x.dataset.v === view)));
    if (!heat || !map.getLayer("line")) return;
    const k = heat.frames[key()] ? key() : "night";
    if (!map.getSource("heat")) {
      map.addSource("heat", { type: "image", url: heatUrl(heat, k), coordinates: coords() });
      map.addLayer({ id: "heat", type: "raster", source: "heat", paint: { "raster-opacity": 0.72, "raster-fade-duration": 0 } }, "line");
    } else if (shown !== k) (map.getSource("heat") as maplibregl.ImageSource).updateImage({ url: heatUrl(heat, k), coordinates: coords() });
    shown = k;
    needLevels(k);
    map.setLayoutProperty("heat", "visibility", view === "heat" ? "visible" : "none");
    map.setLayoutProperty("dfill", "visibility", view === "dong" ? "visible" : "none");
    if (shares) {
      const cur = shares[k] ?? {};
      for (const f of data.geo.features) {
        const s = cur[(f.properties as any).code];
        map.setFeatureState({ source: "dongs", id: f.id as number }, s ? { has: true, b: dongGrade(s[3], heat.frames[k].cuts) } : { has: false, b: 0 });
      }
    }
    map.setFilter("dsel", ["==", ["get", "code"], view === "dong" || !pick ? dongSel ?? "" : ""]);
    styleLines();
    root.querySelector("#lbody")!.innerHTML = view === "heat"
      ? `<ul class="chips">${heat.colors.map((c, i) => `<li><span ${i === 0 ? 'class="nodata"' : `style="background:${c}"`}></span><b>${WORDS[i]}</b></li>`).join("")}</ul>`
      : `<ul class="chips">${DONG_COLORS.map((c, i) => `<li><span style="background:${c}"></span><b>${WORDS[i]}</b></li>`).join("")}</ul>`;
    applyOpacity();
    renderPanel();
    writeUrl();
    if (view3D()) root.querySelector("#v3d-title")!.textContent = title3D();
  };
  const setHour = (h: number, fromPlay = false) => {
    hour = (h + 24) % 24; sel = null;
    slider.value = String(hour);
    if (!fromPlay) stop();
    paint();
  };
  const setMode = (v: View) => {
    view = v;
    if (v === "dong") { pick = null; pin?.remove(); pin = null; }
    paint();
  };
  const fitDong = (code: string) => {
    const f = data.geo.features.find((x) => (x.properties as any).code === code);
    if (!f) return;
    const b = new maplibregl.LngLatBounds();
    const walk = (c: any) => (typeof c[0] === "number" ? b.extend(c as [number, number]) : c.forEach(walk));
    walk((f.geometry as any).coordinates);
    map.fitBounds(b, { padding: 60, maxZoom: 14.5, duration: view3D() ? 0 : 600 });
  };
  const selectDong = (code: string | null, fly = false) => {
    dongSel = code && data.dongs[code] ? code : null;
    if (dongSel && fly) fitDong(dongSel);
    paint();
    if (view3D()) { v3dCenter = null; setTimeout(() => sync3D(fly), fly ? 50 : 0); }
  };

  map.once("style.load", () => {
    map.addSource("dongs", { type: "geojson", data: data.geo });
    const col: any = ["match", ["coalesce", ["feature-state", "b"], 0], 1, DONG_COLORS[1], 2, DONG_COLORS[2], DONG_COLORS[0]];
    map.addLayer({ id: "dfill", type: "fill", source: "dongs", layout: { visibility: "none" },
      paint: { "fill-color": col, "fill-opacity": ["case", ["boolean", ["feature-state", "has"], false], 0.72, 0], "fill-color-transition": { duration: 300 } } as any });
    map.addLayer({ id: "line", type: "line", source: "dongs", paint: { "line-color": lineBase, "line-width": 0.5, "line-opacity": 0.3 } });
    // 지명·도로 이름: 색칠에 가려지지 않게 맨 위에 다시 얹는다 (브이월드 Hybrid = 투명 바탕의 지명·도로)
    if (VW_KEY) map.addLayer({ id: "vw-label", type: "raster", source: "vw-label", paint: { "raster-opacity": 0.85 } });
    map.addLayer({ id: "dsel", type: "line", source: "dongs", filter: ["==", ["get", "code"], ""], paint: { "line-color": "#111827", "line-width": 2.5 } });
    setBasemap("light");
    paint();
    if (dongSel && view === "dong") fitDong(dongSel);

    const pop = new maplibregl.Popup({ closeButton: false, closeOnClick: false, className: "tip" });
    map.on("mousemove", "dfill", (e) => {
      const code = String(e.features?.[0]?.properties?.code ?? "");
      const s = heat && shares?.[shown]?.[code];
      map.getCanvas().style.cursor = "pointer";
      pop.setLngLat(e.lngLat).setHTML(`<b>${escHtml(dongName(code))}</b><br>${s ? `${WORDS[dongGrade(s[3], heat!.frames[shown].cuts)]} · ${heat!.scores[dongGrade(s[3], heat!.frames[shown].cuts)]}점` : "값 없음"}`).addTo(map);
    });
    map.on("mouseleave", "dfill", () => { map.getCanvas().style.cursor = ""; pop.remove(); });
    map.on("click", (e) => {
      if (!heat) return;
      clearPlace();
      if (view === "dong") { selectDong(dongAt(data, e.lngLat.lng, e.lngLat.lat)); return; }
      dongSel = null;
      pick = { lon: e.lngLat.lng, lat: e.lngLat.lat };
      pin?.remove();
      pin = new maplibregl.Marker({ color: "#111827", scale: 0.7 }).setLngLat(e.lngLat).addTo(map);
      paint();
    });
  });

  // ── 보기 방식, 시간대, 시각 막대, 재생 ──
  const playBtn = root.querySelector<HTMLButtonElement>("#tplay")!;
  const stop = () => {
    if (!playing) return;
    clearInterval(playing); playing = 0;
    playBtn.setAttribute("aria-pressed", "false"); playBtn.textContent = "▶ 하루 재생";
  };
  vBtns.forEach((b) => b.addEventListener("click", () => setMode(b.dataset.v as View)));
  trBtns.forEach((b) => b.addEventListener("click", () => { stop(); sel = b.dataset.tr as "night" | "day"; paint(); }));
  slider.addEventListener("input", () => setHour(+slider.value));
  playBtn.addEventListener("click", () => {
    if (playing) { stop(); return; }
    playBtn.setAttribute("aria-pressed", "true"); playBtn.textContent = "■ 멈춤";
    playing = window.setInterval(() => setHour(hour + 1, true), 900);
  });

  Promise.all([loadHeat(), loadDongShares()]).then(([h, s]) => {
    heat = h; shares = s;
    const fp = document.getElementById("foot-period");
    if (fp) fp.textContent = `${h.year}년 한 해`;
    paint();
    if (lastPlace) showPlace(lastPlace);
  }).catch((e) => { panel.innerHTML = `<p class="empty">소음 자료를 불러오지 못했습니다. (${escHtml(String(e))})</p>`; });
  // 첫 안내: 닫거나 지도를 한 번 누르면 사라진다
  const maphint = root.querySelector<HTMLElement>("#maphint")!;
  maphint.querySelector("button")!.addEventListener("click", () => (maphint.hidden = true));
  map.on("click", () => (maphint.hidden = true));
  // 배경 지도 전환 + 색 진하기
  const viewButtons = [...root.querySelectorAll<HTMLButtonElement>(".basemap button")];
  const bmLight = root.querySelector<HTMLInputElement>("#bmlight")!;
  const op = root.querySelector<HTMLInputElement>("#op")!;
  const opLabel = root.querySelector<HTMLElement>("#oplabel")!;
  const applyOpacity = () => {
    const v = +op.value / 100;
    opLabel.textContent = v === 0 ? "0% (색 끔 · 지도만 보기)" : `${op.value}%`;
    if (map.getLayer("heat")) map.setPaintProperty("heat", "raster-opacity", v);
    if (map.getLayer("dfill")) map.setPaintProperty("dfill", "fill-opacity", ["case", ["boolean", ["feature-state", "has"], false], v, 0]);
    root.querySelector<HTMLElement>(".legend")!.classList.toggle("dim", v === 0);
  };
  const setBasemap = (mode: Basemap) => {
    markView(mode === "sat" ? "sat" : "map");
    if (!map.getLayer("vw-dark")) return;
    for (const m of ["dark", "light", "sat"] as Basemap[]) map.setLayoutProperty(`vw-${m}`, "visibility", m === mode ? "visible" : "none");
    // 밝은 지도·항공사진 위에서는 동 경계를 눈에 띄게, 색은 조금 옅게 해서 바탕이 보이게
    lineBase = mode === "dark" ? "#8a93a6" : mode === "light" ? "#5b667d" : "#ffffff";
    styleLines();
    op.value = mode === "dark" ? "80" : "72";
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

  // 실사 3D: 브이월드 3D 지도를 같은 위치로 띄운다 (별도 화면)
  const v3d = root.querySelector<HTMLElement>("#v3d")!;
  const v3dFrame = root.querySelector<HTMLIFrameElement>("#v3d-frame")!;
  // 같은 지도 자리에 3D를 겹쳐 보여 준다. 한 번 불러온 3D는 켜 둔 채 위치·동만 바꿔서 바로 전환되게 한다
  let v3dLoaded = false;
  let v3dCenter: { lon: number; lat: number } | null = null;   // 3D에서 보고 있던 곳 (2D로 돌아올 때 맞춤)
  let is3D = false;
  const view3D = () => is3D;
  const v3dLoading = root.querySelector<HTMLElement>("#v3d-loading")!;
  let v3dTimer = 0;
  const wrap = root.querySelector<HTMLElement>(".mapwrap")!;
  const pause3D = () => v3dFrame.contentWindow?.postMessage({ type: "jamjal-3d", pause: true }, location.origin);
  let hide2D = 0;
  const reveal3D = () => {
    clearTimeout(v3dTimer); v3dLoading.hidden = true;
    if (!is3D) { pause3D(); return; }                 // 미리 불러오기가 끝난 것: 보일 때까지 그리기를 멈춰 둔다
    v3d.classList.add("on");
    wrap.classList.add("is3d");                       // 3D 위에 뜨는 상자의 흐림 효과를 끈다(움직이는 3D 위에서는 매 장면 다시 계산돼 무겁다)
    clearTimeout(hide2D);
    hide2D = window.setTimeout(() => { if (is3D) wrap.classList.add("hide2d"); }, 900);   // 겹치기가 끝나면 아래의 2D 지도는 그리지 않는다
  };
  const sync3D = (move = true, enter = false) => {
    const c = marker ? marker.getLngLat() : map.getCenter();
    const showDong = !!dongSel && map.getZoom() >= 12.5;    // 동네를 찾아 들어왔을 때만 그 경계선을 함께 그린다
    const height = Math.max(300, Math.min(30000, 700 * 2 ** (15 - map.getZoom())));
    // 2D 화면 세로에 담긴 땅의 길이(m): 3D가 같은 범위를 위에서 내려다보는 모습으로 시작하게 한다
    const extent = map.getContainer().clientHeight * (78271.517 * Math.cos((c.lat * Math.PI) / 180)) / 2 ** map.getZoom();
    const msg = { type: "jamjal-3d", move, enter, extent: Math.round(extent), lon: +c.lng.toFixed(6), lat: +c.lat.toFixed(6), height: Math.round(height),
      code: showDong ? dongSel! : "", color: "#ffffff" };
    root.querySelector("#v3d-title")!.textContent = title3D();
    if (!v3dLoaded) {
      const q = new URLSearchParams(Object.entries(msg).filter(([k]) => k !== "type" && k !== "move" && k !== "enter").map(([k, x]) => [k, String(x)]));
      v3dFrame.src = `${import.meta.env.BASE_URL}vworld3d.html?${q}`;
      v3dLoaded = true;
    } else v3dFrame.contentWindow?.postMessage(msg, location.origin);
  };
  const openReal3D = () => {
    if (!VW_KEY) { alert("브이월드 인증키(VITE_VWORLD_KEY)가 없어 실사 3D를 열 수 없습니다."); return; }
    if (is3D) return;
    // 새 화면으로 바꾸지 않는다: 3D를 2D와 같은 '위에서 본 모습'으로 맞춘 뒤 서서히 겹치고, 그다음 시점을 기울인다
    is3D = true;
    // 배경지도에서 넘어올 때도 같은 항공사진끼리 겹치도록 아래 지도를 먼저 항공사진으로 바꾼다
    if (map.getLayer("vw-sat") && map.getLayoutProperty("vw-sat", "visibility") !== "visible") setBasemap("sat");
    root.querySelector<HTMLElement>("#maphint")!.hidden = true;
    v3d.hidden = false;                 // 아직 투명 (.on 이 붙어야 보임)
    v3dLoading.hidden = false;
    markView("3d");
    v3dCenter = null;
    sync3D(true, true);
    clearTimeout(v3dTimer);
    v3dTimer = window.setTimeout(reveal3D, 25000);  // 3D가 답을 못 해도 화면은 넘어가게 (처음 불러올 때는 10초 넘게 걸릴 수 있음)
  };
  // 처음 불러오는 데 오래 걸리므로, 실사 2D를 고르거나 3D 버튼에 손이 가면 보이지 않게 미리 불러 둔다
  const preload3D = () => {
    if (v3dLoaded || !VW_KEY) return;
    v3d.hidden = false;                 // 투명한 채로 자리만 잡는다 (눌리지도 않음)
    sync3D(true, false);
  };
  const b3d = root.querySelector<HTMLButtonElement>('[data-view="3d"]')!;
  b3d.addEventListener("pointerenter", preload3D);
  b3d.addEventListener("focus", preload3D);
  root.querySelector<HTMLButtonElement>('[data-view="sat"]')!.addEventListener("click", () => window.setTimeout(preload3D, 1200));
  // 어느 화면에서 눌러도 바로 넘어가도록, 지도가 다 그려지고 한가해지면 미리 불러 둔다 (휴대폰·데이터 절약 모드에서는 누를 때만)
  const eager = window.matchMedia("(min-width: 901px)").matches && !(navigator as any).connection?.saveData;
  if (eager) map.once("idle", () => window.setTimeout(() => ((window as any).requestIdleCallback ?? window.setTimeout)(preload3D), 2500));
  const closeReal3D = () => {
    if (!is3D) return;
    is3D = false;
    clearTimeout(v3dTimer);
    v3dLoading.hidden = true;
    if (v3dCenter) map.jumpTo({ center: [v3dCenter.lon, v3dCenter.lat] });   // 3D에서 옮겨 간 곳을 2D에서도 이어서 봄
    clearTimeout(hide2D);
    wrap.classList.remove("is3d", "hide2d");
    v3d.classList.remove("on");         // 서서히 사라진 뒤에 치운다
    window.setTimeout(() => { if (!is3D) { v3d.hidden = true; pause3D(); } }, 500);
  };
  const on3DMessage = (e: MessageEvent) => {
    if (e.origin !== location.origin) return;
    if (e.data?.type === "jamjal-3d-top") { reveal3D(); return; }   // 3D가 위에서 본 모습으로 준비됨 → 겹치기 시작
    if (e.data?.type !== "jamjal-3d-pos") return;
    if (Number.isFinite(e.data.lon) && Number.isFinite(e.data.lat)) v3dCenter = { lon: e.data.lon, lat: e.data.lat };
  };
  window.addEventListener("message", on3DMessage);
  // ── 검색: 동 이름이면 그 동네로, 아니면 건물·장소 ──────────────────
  const qInput = root.querySelector<HTMLInputElement>("#q")!;
  const qmsg = root.querySelector<HTMLElement>("#qmsg")!;
  const qres = root.querySelector<HTMLUListElement>("#qres")!;
  const findDong = (v: string) =>
    Object.values(data.dongs).find((x) => `${x.gu} ${x.name}` === v) ?? Object.values(data.dongs).find((x) => x.name === v);
  const goDong = (code: string) => {
    clearPlace(); pick = null; pin?.remove(); pin = null;
    selectDong(code, true);
    if (view === "heat") renderPanel(`<b>${escHtml(dongName(code))}</b>(굵은 선)로 옮겼습니다.`);
  };
  qInput.addEventListener("change", () => {
    const d = findDong(qInput.value.trim());
    if (d) { qres.innerHTML = ""; qmsg.textContent = ""; goDong(d.code); }
  });
  root.querySelector<HTMLFormElement>("#qform")!.addEventListener("submit", async (e) => {
    e.preventDefault();
    const v = qInput.value.trim();
    qres.innerHTML = "";
    if (!v) return;
    const d = findDong(v);
    if (d) { qmsg.textContent = ""; goDong(d.code); return; }
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
  const clearPlace = () => { lastPlace = null; marker?.remove(); marker = null; };
  const showPlace = (p: Place, fly = true) => {
    lastPlace = p;
    if (!heat) return;                       // 자료가 오면 다시 부른다
    marker?.remove();
    marker = new maplibregl.Marker({ color: "#f5b041" }).setLngLat([p.lon, p.lat]).addTo(map);
    if (fly && view3D()) { map.jumpTo({ center: [p.lon, p.lat], zoom: 15 }); sync3D(true); }
    else if (fly) map.flyTo({ center: [p.lon, p.lat], zoom: 14.5, duration: 700 });
    if (view === "dong") { dongSel = dongAt(data, p.lon, p.lat); paint(); }
    else { dongSel = null; pick = { lon: p.lon, lat: p.lat }; pin?.remove(); pin = null; paint(); }
    panel.querySelector(".pc-kicker")?.insertAdjacentHTML("beforebegin", `<p class="plain"><b>${escHtml(p.name)}</b> ${view === "dong" ? "이(가) 있는 동네입니다." : "자리의 소음입니다. 이 건물을 직접 잰 값은 아닙니다."}</p>`);
  };

  // 공유한 주소로 들어오면 장소 다시 표시
  const pp = params.get("p");
  if (pp) {
    const [lat, lon] = pp.split(",").map(Number);
    showPlace({ name: params.get("n") ?? "선택한 장소", addr: "", lat, lon });
  }
  return () => { stop(); window.removeEventListener("message", on3DMessage); map.remove(); };
}
