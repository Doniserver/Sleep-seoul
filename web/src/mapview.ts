import * as maplibregl from "maplibre-gl";
import type { Map as MlMap, StyleSpecification } from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?url";
import { type Cell, type CellsFile, GRADES, type Grade, cellIdAt, gradeOf, hourLabel, loadCells } from "./cells";
import { type Data, type YearInfo, loadYearsIndex, sortedDongs } from "./data";
import { type Place, dist, dongAt, searchPlaces } from "./place";

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

const START_HOUR = 23;
// 소음 색칠을 잠시 끈다 (2026-11-18: 표현 방식을 다시 정하는 동안). true 로 바꾸면 500m 칸 + 시각 막대가 다시 나온다
const NOISE_ON = false;

export function renderMap(root: HTMLElement, data: Data, params: URLSearchParams) {
  const chip = (g: Grade, score: number) => `<li><span style="background:${GRADES[g].color}"></span><b>${GRADES[g].word}</b> ${score}점</li>`;
  root.innerHTML = `
  <div class="mapgrid">
    <section class="mapwrap" aria-label="서울 시간대별 소음 지도">
      <div id="v3d" class="v3d" hidden>
        <iframe id="v3d-frame" title="브이월드 실사 3D 지도" allow="fullscreen"></iframe>
        <p class="v3d-chip" id="v3d-title" aria-live="polite"></p>
        <p class="v3d-note">실제 건물 모습은 브이월드(국토교통부) 3D 지도입니다. 소음은 건물마다 잰 것이 아니라 길가 센서가 잰 값입니다.</p>
      </div>
      <p class="v3d-loading" id="v3d-loading" role="status" hidden>실사 3D로 넘어가는 중…</p>
      <div id="map" role="application" aria-label="500m 칸별 소음 지도. 시각 막대로 0시부터 23시까지 바꿔 볼 수 있습니다."></div>
      <div class="ctrl">
        <form class="search" id="qform" role="search">
          <label for="q" class="sr">동네·건물·장소 찾기</label>
          <div class="qrow">
            <input list="dong-list" id="q" placeholder="동네·건물·역 이름으로 찾기" autocomplete="off" />
            <button type="submit">찾기</button>
          </div>
          <p id="qmsg" class="qmsg" aria-live="polite"></p>
          <ul id="qres" class="qres"></ul>
        </form>
        <datalist id="dong-list">${sortedDongs(data).map((d) => `<option value="${d.gu} ${d.name}"></option>`).join("")}</datalist>
        <div class="tslider">
          <div class="ts-head">
            <p><b id="tlabel" aria-live="polite">${hourLabel(START_HOUR)}</b> <span id="tsub">${START_HOUR}시~${START_HOUR + 1}시</span></p>
            <button type="button" id="tplay" aria-pressed="false">▶ 하루 재생</button>
          </div>
          <input type="range" id="thour" min="0" max="23" step="1" value="${START_HOUR}" aria-label="시각 (0시~23시)" />
          <div class="ts-ticks" aria-hidden="true"><span>0시</span><span>6시</span><span>12시</span><span>18시</span><span>23시</span></div>
        </div>
        <div class="row basemap" role="group" aria-label="지도 보기 방식">
          <button type="button" data-view="map" aria-pressed="true">배경지도</button>
          <button type="button" data-view="sat" aria-pressed="false">실사 2D</button>
          <button type="button" data-view="3d" aria-pressed="false">실사 3D</button>
        </div>
        <details class="more">
          <summary>지도 설정</summary>
          <div class="morebody">
            <label class="lightopt"><input type="checkbox" id="bmlight" /> 배경지도를 밝게</label>
            <label class="opacity">색 진하기 <span id="oplabel">85%</span>
              <input type="range" id="op" min="0" max="100" step="5" value="85" aria-describedby="oplabel" />
            </label>
          </div>
        </details>
      </div>
      <p class="maphint" id="maphint"><span><b>막대를 끌면</b> 시간에 따라 색이 바뀝니다</span><button type="button" aria-label="안내 닫기">×</button></p>
      <div class="maplegend">
        <div class="legend" aria-label="색 설명">
          <p><span id="lwhen">${hourLabel(START_HOUR)}</span>의 집 밖 소음</p>
          <ul class="chips" id="lchips"></ul>
          <p class="hint">색이 없는 곳은 센서가 없어 <b>재지 못한 곳</b>입니다.</p>
        </div>
      </div>
    </section>
    <aside id="panel" class="panel" aria-live="polite"></aside>
  </div>`;

  let year: number | null = null;
  let yearInfos: YearInfo[] = [];
  let file: CellsFile | null = null;
  const byId = new Map<string, { cell: Cell; fid: number }>();
  let hour = Math.min(23, Math.max(0, Number(params.get("h") ?? START_HOUR) || 0));
  if (!params.has("h")) hour = START_HOUR;
  let selected: string | null = params.get("c");
  let dongSel: string | null = null;         // 이름으로 찾은 동네 (경계선만 보여 준다)
  let playing = 0;

  const periodLabel = () => {
    if (!year) return "";
    const y = yearInfos.find((x) => x.year === year);
    return y ? `${year}년 · ${y.start} ~ ${y.end}${y.partial ? " (일부 기간)" : ""}` : `${year}년`;
  };
  const map: MlMap = new maplibregl.Map({ container: "map", style: STYLE, center: [126.99, 37.56], zoom: 10.6, minZoom: 9, maxZoom: 18, attributionControl: { compact: true } });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
  if (import.meta.env.DEV) (window as any).__map = map; // 개발 중 디버그용

  const panel = root.querySelector<HTMLElement>("#panel")!;
  const slider = root.querySelector<HTMLInputElement>("#thour")!;
  slider.value = String(hour);
  const gradeAt = (c: Cell, h = hour): Grade => gradeOf(c.h[h], file!.cuts);
  const whereOf = (c: Cell) => {
    const code = dongAt(data, c.lon, c.lat);
    const d = code ? data.dongs[code] : null;
    return d ? `${d.gu} ${d.name}` : "서울";
  };
  const title3D = () => {
    const s = selected ? byId.get(selected) : null;
    return s && file ? `${whereOf(s.cell)} 부근 · ${hourLabel(hour)} ${GRADES[gradeAt(s.cell)].word}` : "";
  };
  const writeUrl = () => history.replaceState(null, "", `#/map?h=${hour}${selected ? `&c=${selected}` : ""}`);

  // ── 오른쪽 안내 칸 ──
  const OFF_HTML = `<h2>소음 표시를 준비하고 있습니다</h2>
      <p class="plain">소음을 더 정확하고 알아보기 쉽게 보여 주는 방법을 다시 정하는 중이라, 지도의 소음 색을 잠시 내렸습니다.</p>
      <p class="hint">지금은 배경지도·실사 2D·실사 3D와 장소 찾기만 쓸 수 있습니다.</p>`;
  const intro = (note = "") => {
    if (!NOISE_ON) { panel.innerHTML = `<div class="intro">${note ? `<p class="plain">${note}</p>` : ""}${OFF_HTML}</div>`; return; }
    if (!file) { panel.innerHTML = `<div class="intro"><p class="loading">불러오는 중…</p></div>`; return; }
    const n = [0, 0, 0];
    for (const c of file.cells) n[gradeAt(c)]++;
    panel.innerHTML = `
      <div class="intro">
        <h2>서울, 언제 어디가 조용할까요?</h2>
        ${note ? `<p class="plain">${note}</p>` : ""}
        <p><b class="c-quiet">파란 칸</b>은 조용하고 <b class="c-loud">주황 칸</b>은 시끄럽습니다.</p>
        <ol class="steps">
          <li><span><b>시각 막대를 끌어 보세요.</b> 0시부터 23시까지 색이 바뀝니다.</span></li>
          <li><span><b>색칠된 칸을 눌러 보세요.</b> 그 자리의 하루가 나옵니다.</span></li>
          <li><span><b>실사 2D·3D</b>로 실제 건물을 확인하세요.</span></li>
        </ol>
        <p class="nowcount"><b>${hourLabel(hour)}</b> · 조용 ${n[0]}칸 · 보통 ${n[1]}칸 · 시끄러움 ${n[2]}칸</p>
        <p class="hint">칸 하나는 폭 ${file.hex_m}m입니다. 길가 센서가 ${year}년 한 해 동안 잰 집 밖 소음이며, 집 안 소음이 아닙니다. 센서가 있는 칸만 색을 칠했고 빈 곳을 짐작으로 채우지 않았습니다.</p>
      </div>`;
  };
  const card = (c: Cell) => {
    const g = gradeAt(c), G = GRADES[g];
    const strip = c.h.map((v, h) => `<button type="button" data-h="${h}" class="${h === hour ? "on" : ""}" style="background:${GRADES[gradeOf(v, file!.cuts)].color}" aria-label="${hourLabel(h)} ${GRADES[gradeOf(v, file!.cuts)].word}"></button>`).join("");
    const quiet = c.h.filter((v) => gradeOf(v, file!.cuts) === 0).length, loud = c.h.filter((v) => gradeOf(v, file!.cuts) === 2).length;
    panel.innerHTML = `
      <section class="cellcard" aria-label="고른 칸의 소음">
        <p class="pc-kicker">${escHtml(whereOf(c))} 부근 · ${hourLabel(hour)}</p>
        <h2><span class="lv lv-${G.tone}">${G.word}</span> <b>${file!.scores[g]}점</b></h2>
        <p class="plain">${G.feel}</p>
        <h3>이 자리의 하루</h3>
        <div class="daystrip" role="group" aria-label="0시부터 23시까지의 소음. 누르면 그 시각으로 바뀝니다.">${strip}</div>
        <div class="ts-ticks" aria-hidden="true"><span>0시</span><span>6시</span><span>12시</span><span>18시</span><span>23시</span></div>
        <p class="plain">하루 24시간 가운데 조용한 시간이 <b>${quiet}시간</b>, 시끄러운 시간이 <b>${loud}시간</b>입니다.</p>
        <p class="hint">이 칸 안의 길가 센서 ${c.n}곳이 ${year}년 한 해 동안 잰 값입니다${c.n === 1 ? " (센서가 1곳뿐이라 그 센서가 달린 자리의 영향을 받습니다)" : ""}. 집 안 소음이 아니며, 간이측정기로 잰 비교용 값입니다.</p>
        <details class="more-report"><summary>숫자로 보기</summary>
          <p class="plain">${hourLabel(hour)} 평균 <b>${c.h[hour].toFixed(1)}dB</b> · 하루 중 가장 조용할 때 ${Math.min(...c.h).toFixed(1)}dB · 가장 시끄러울 때 ${Math.max(...c.h).toFixed(1)}dB</p>
          <p class="hint">${file!.cuts[0]}dB 미만은 조용, ${file!.cuts[1]}dB 미만은 보통, 그 이상은 시끄러움으로 나눴습니다.</p>
        </details>
        <button type="button" class="link" id="cardclose">← 처음 안내로</button>
      </section>`;
    panel.querySelectorAll<HTMLButtonElement>(".daystrip button").forEach((b) => b.addEventListener("click", () => setHour(+b.dataset.h!)));
    panel.querySelector("#cardclose")!.addEventListener("click", () => select(null));
  };
  const renderPanel = (note = "") => {
    const s = selected ? byId.get(selected) : null;
    if (s && file) card(s.cell); else intro(note);
  };

  // ── 색칠 ──
  const paint = () => {
    root.querySelector("#tlabel")!.textContent = hourLabel(hour);
    root.querySelector("#tsub")!.textContent = `${hour}시~${hour + 1}시`;
    root.querySelector("#lwhen")!.textContent = hourLabel(hour);
    if (!file || !map.getSource("cells")) return;
    for (const { cell, fid } of byId.values()) map.setFeatureState({ source: "cells", id: fid }, { g: gradeAt(cell) });
  };
  const setHour = (h: number, fromPlay = false) => {
    hour = (h + 24) % 24;
    slider.value = String(hour);
    if (!fromPlay) stop();
    paint(); renderPanel(); writeUrl();
    if (view3D()) root.querySelector("#v3d-title")!.textContent = title3D();
  };
  const select = (id: string | null, fly = false) => {
    selected = id && byId.has(id) ? id : null;
    if (map.getLayer("sel")) map.setFilter("sel", ["==", ["get", "id"], selected ?? ""]);
    renderPanel(); writeUrl();
    const s = selected ? byId.get(selected)! : null;
    if (s && fly) map.flyTo({ center: [s.cell.lon, s.cell.lat], zoom: Math.max(map.getZoom(), 13.5), duration: view3D() ? 0 : 600 });
    if (view3D()) { v3dCenter = null; setTimeout(() => sync3D(fly), fly ? 50 : 0); }
  };
  const showDong = (code: string) => {
    dongSel = code;
    if (map.getLayer("dsel")) map.setFilter("dsel", ["==", ["get", "code"], code]);
    const f = data.geo.features.find((x) => (x.properties as any).code === code);
    if (f) {
      const b = new maplibregl.LngLatBounds();
      const walk = (c: any) => (typeof c[0] === "number" ? b.extend(c as [number, number]) : c.forEach(walk));
      walk((f.geometry as any).coordinates);
      map.fitBounds(b, { padding: 60, maxZoom: 14.5, duration: view3D() ? 0 : 600 });
    }
    const d = data.dongs[code];
    selected = null;
    if (map.getLayer("sel")) map.setFilter("sel", ["==", ["get", "id"], ""]);
    const inside = file ? file.cells.filter((c) => dongAt(data, c.lon, c.lat) === code).length : 0;
    intro(`<b>${escHtml(d.gu)} ${escHtml(d.name)}</b>(흰 선)로 옮겼습니다. ${!NOISE_ON ? "" : inside ? "색칠된 칸을 누르면 그 자리의 소음이 나옵니다." : "이 동네에는 센서가 있는 칸이 없어 색이 없습니다."}`);
    writeUrl();
    if (view3D()) sync3D(true);
  };

  // 배경 타일을 다 받을 때까지 기다리지 않고, 스타일만 준비되면 바로 색칠
  let styleReady = false;
  const addCells = () => {
    if (!styleReady || !file || map.getSource("cells")) return;
    byId.clear();
    const fc: any = { type: "FeatureCollection", features: file.cells.map((c, i) => {
      byId.set(c.id, { cell: c, fid: i });
      return { type: "Feature", id: i, properties: { id: c.id }, geometry: { type: "Polygon", coordinates: [c.ring] } };
    }) };
    map.addSource("cells", { type: "geojson", data: fc });
    const color: any = ["match", ["coalesce", ["feature-state", "g"], 1], 0, GRADES[0].color, 2, GRADES[2].color, GRADES[1].color];
    map.addLayer({ id: "fill", type: "fill", source: "cells", paint: { "fill-color": color, "fill-opacity": 0.85, "fill-color-transition": { duration: 350 } } as any }, "line");
    map.addLayer({ id: "cline", type: "line", source: "cells", paint: { "line-color": "#0b111c", "line-width": 1 } }, "line");
    map.addLayer({ id: "sel", type: "line", source: "cells", filter: ["==", ["get", "id"], selected ?? ""], paint: { "line-color": "#ffffff", "line-width": 3 } });
    root.querySelector("#lchips")!.innerHTML = ([0, 1, 2] as Grade[]).map((g) => chip(g, file!.scores[g])).join("") + `<li><span class="nodata"></span>측정 없음</li>`;
    paint(); applyOpacity();
    if (selected && !byId.has(selected)) selected = null;
    if (lastPlace) showPlace(lastPlace); else { renderPanel(); if (selected) select(selected, true); }

    const pop = new maplibregl.Popup({ closeButton: false, closeOnClick: false, className: "tip" });
    map.on("mousemove", "fill", (e) => {
      const c = byId.get(String(e.features?.[0]?.properties?.id))?.cell; if (!c) return;
      map.getCanvas().style.cursor = "pointer";
      const g = gradeAt(c);
      pop.setLngLat(e.lngLat).setHTML(`<b>${GRADES[g].word}</b> ${file!.scores[g]}점<br>${hourLabel(hour)}`).addTo(map);
    });
    map.on("mouseleave", "fill", () => { map.getCanvas().style.cursor = ""; pop.remove(); });
    map.on("click", "fill", (e) => {
      const id = String(e.features?.[0]?.properties?.id ?? "");
      clearPlace();
      select(id);
    });
  };
  map.once("style.load", () => {
    styleReady = true;
    // 동네 경계는 위치를 알아보는 용도로만 옅게 긋는다 (색은 칸에만 칠한다)
    map.addSource("dongs", { type: "geojson", data: data.geo });
    map.addLayer({ id: "line", type: "line", source: "dongs", paint: { "line-color": "#8a93a6", "line-width": 0.5, "line-opacity": 0.35 } });
    // 지명·도로 이름: 색칠에 가려지지 않게 맨 위에 다시 얹는다 (브이월드 Hybrid = 투명 바탕의 지명·도로)
    if (VW_KEY) map.addLayer({ id: "vw-label", type: "raster", source: "vw-label", paint: { "raster-opacity": 0.85 } });
    map.addLayer({ id: "dsel", type: "line", source: "dongs", filter: ["==", ["get", "code"], ""], paint: { "line-color": "#ffffff", "line-width": 2, "line-dasharray": [2, 1.5] } });
    addCells();
  });

  // ── 시각 막대 + 재생 ──
  const playBtn = root.querySelector<HTMLButtonElement>("#tplay")!;
  const stop = () => {
    if (!playing) return;
    clearInterval(playing); playing = 0;
    playBtn.setAttribute("aria-pressed", "false"); playBtn.textContent = "▶ 하루 재생";
  };
  slider.addEventListener("input", () => setHour(+slider.value));
  playBtn.addEventListener("click", () => {
    if (playing) { stop(); return; }
    playBtn.setAttribute("aria-pressed", "true"); playBtn.textContent = "■ 멈춤";
    playing = window.setInterval(() => setHour(hour + 1, true), 900);
  });

  // 화면에 쓰는 해는 하나: 가장 최근에 끝난 해
  if (!NOISE_ON) {
    for (const q of [".tslider", ".maplegend", "#maphint"]) root.querySelector<HTMLElement>(q)!.hidden = true;
    intro();
  } else intro();
  if (NOISE_ON) loadYearsIndex().then(async (ys) => {
    yearInfos = ys;
    const want = ys[ys.length - 1]?.year;
    if (!want) return;
    year = want;
    try { file = await loadCells(want); } catch (e) { panel.innerHTML = `<p class="empty">칸 자료를 불러오지 못했습니다. (${escHtml(String(e))})</p>`; return; }
    const fp = document.getElementById("foot-period");
    if (fp) fp.textContent = periodLabel();
    addCells();
    renderPanel();
  });
  // 첫 안내: 닫거나 지도를 한 번 누르거나 막대를 움직이면 사라진다
  const maphint = root.querySelector<HTMLElement>("#maphint")!;
  maphint.querySelector("button")!.addEventListener("click", () => (maphint.hidden = true));
  map.on("click", () => (maphint.hidden = true));
  slider.addEventListener("input", () => (maphint.hidden = true), { once: true });
  // 배경 지도 전환 + 색 진하기
  const viewButtons = [...root.querySelectorAll<HTMLButtonElement>(".basemap button")];
  const bmLight = root.querySelector<HTMLInputElement>("#bmlight")!;
  const op = root.querySelector<HTMLInputElement>("#op")!;
  const opLabel = root.querySelector<HTMLElement>("#oplabel")!;
  const applyOpacity = () => {
    const v = +op.value / 100;
    opLabel.textContent = v === 0 ? "0% (색 끔 · 지도만 보기)" : `${op.value}%`;
    if (map.getLayer("fill")) map.setPaintProperty("fill", "fill-opacity", v);
    root.querySelector<HTMLElement>(".legend")!.classList.toggle("dim", v === 0);
  };
  const setBasemap = (mode: Basemap) => {
    markView(mode === "sat" ? "sat" : "map");
    if (!map.getLayer("vw-dark")) return;
    for (const m of ["dark", "light", "sat"] as Basemap[]) map.setLayoutProperty(`vw-${m}`, "visibility", m === mode ? "visible" : "none");
    // 밝은 지도·항공사진 위에서는 동 경계를 눈에 띄게, 색은 조금 옅게 해서 바탕이 보이게
    map.setPaintProperty("line", "line-color", mode === "dark" ? "#8a93a6" : mode === "light" ? "#3a4763" : "#ffffff");
    if (map.getLayer("cline")) map.setPaintProperty("cline", "line-color", mode === "light" ? "#ffffff" : "#0b111c");
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
  qInput.addEventListener("change", () => {
    const d = findDong(qInput.value.trim());
    if (d) { clearPlace(); qres.innerHTML = ""; qmsg.textContent = ""; showDong(d.code); }
  });
  root.querySelector<HTMLFormElement>("#qform")!.addEventListener("submit", async (e) => {
    e.preventDefault();
    const v = qInput.value.trim();
    qres.innerHTML = "";
    if (!v) return;
    const d = findDong(v);
    if (d) { clearPlace(); qmsg.textContent = ""; showDong(d.code); return; }
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
    if (!NOISE_ON) {
      marker?.remove();
      marker = new maplibregl.Marker({ color: "#f5b041" }).setLngLat([p.lon, p.lat]).addTo(map);
      if (fly && view3D()) { map.jumpTo({ center: [p.lon, p.lat], zoom: 15 }); sync3D(true); }
      else if (fly) map.flyTo({ center: [p.lon, p.lat], zoom: 14.5, duration: 700 });
      intro(`<b>${escHtml(p.name)}</b>(으)로 옮겼습니다.`);
      return;
    }
    if (!file) return;                       // 칸 자료가 오면 addCells()가 다시 부른다
    marker?.remove();
    marker = new maplibregl.Marker({ color: "#f5b041" }).setLngLat([p.lon, p.lat]).addTo(map);
    dongSel = null;
    if (map.getLayer("dsel")) map.setFilter("dsel", ["==", ["get", "code"], ""]);
    const id = cellIdAt(p.lon, p.lat, file.hex_m);
    if (fly && view3D()) { map.jumpTo({ center: [p.lon, p.lat], zoom: 15 }); }
    else if (fly) map.flyTo({ center: [p.lon, p.lat], zoom: 14.5, duration: 700 });
    if (byId.has(id)) {
      select(id);
      panel.querySelector(".pc-kicker")!.insertAdjacentHTML("beforebegin", `<p class="plain"><b>${escHtml(p.name)}</b>이(가) 들어 있는 칸입니다. 이 건물을 직접 잰 값은 아닙니다.</p>`);
    } else {
      selected = null;
      if (map.getLayer("sel")) map.setFilter("sel", ["==", ["get", "id"], ""]);
      const near = file.cells.map((c) => dist(p.lon, p.lat, c.lon, c.lat)).sort((a, b) => a - b)[0];
      intro(`<b>${escHtml(p.name)}</b> 자리에는 센서가 없어 잰 값이 없습니다.${near != null ? ` 가장 가까운 색칠된 칸은 약 ${Math.round(near / 50) * 50}m 떨어져 있습니다.` : ""} 가까운 칸의 값이 이 자리와 같다고 볼 수는 없습니다.`);
      if (view3D()) sync3D(true);
    }
    history.replaceState(null, "", `#/map?h=${hour}&p=${p.lat.toFixed(5)},${p.lon.toFixed(5)}&n=${encodeURIComponent(p.name)}`);
  };

  // 공유한 주소로 들어오면 장소 다시 표시
  const pp = params.get("p");
  if (pp) {
    const [lat, lon] = pp.split(",").map(Number);
    showPlace({ name: params.get("n") ?? "선택한 장소", addr: "", lat, lon });
  }
  return () => { stop(); window.removeEventListener("message", on3DMessage); map.remove(); };
}
