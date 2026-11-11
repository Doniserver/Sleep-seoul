import "./style.css";
import { renderCompare } from "./compare";
import { type Data, loadCore } from "./data";
import { renderMap } from "./mapview";
import { renderMethod } from "./method";

const main = document.getElementById("main")!;
const footer = document.getElementById("footer")!;
let cleanup: (() => void) | void;
let compareA: string | null = null;

function footerHtml(d: Data) {
  const m = d.meta;
  return `<p><b>출처</b> · ${m.sources.map((s) => `<a href="${s.url}" target="_blank" rel="noopener">${s.name}</a> (${s.by})`).join(" · ")} · 배경지도 © OpenStreetMap · OpenFreeMap · 위성 영상 © Esri, Maxar, Earthstar Geographics</p>
  <p><b>데이터 기간</b> <span id="foot-period">${m.period.start} ~ ${m.period.end} 밤 (${m.period.nights}일)</span> · <b>생성</b> ${m.generated_at.replace("T", " ")} KST ·
  소음은 길가 센서로 잰 동네 바깥 환경이며 간이측정기 기반 비교용 지표입니다. 층간소음 등급은 건축 연식 기준 추정입니다.</p>`;
}

async function route() {
  if (cleanup) cleanup();
  cleanup = undefined;
  const [path, qs] = (location.hash.replace(/^#\/?/, "") || "map").split("?");
  const params = new URLSearchParams(qs ?? "");
  document.querySelectorAll<HTMLAnchorElement>("nav a").forEach((a) => a.toggleAttribute("aria-current", a.dataset.route === path));
  main.innerHTML = `<p class="loading">불러오는 중…</p>`;
  let data: Data;
  try {
    data = await loadCore();
  } catch (e) {
    main.innerHTML = `<p class="empty">데이터를 불러오지 못했습니다. (${String(e)})</p>`;
    return;
  }
  footer.innerHTML = footerHtml(data);
  document.body.dataset.route = path;
  if (path === "compare") {
    renderCompare(main, data, params);
    document.title = "두 동네 비교 · 잠 잘 오는 동네";
  } else if (path === "method") {
    renderMethod(main, data);
    document.title = "방법과 한계 · 잠 잘 오는 동네";
  } else {
    document.title = "잠 잘 오는 동네";
    cleanup = renderMap(main, data, params, (code) => {
      if (!compareA || compareA === code) {
        compareA = code;
        const b = document.querySelector<HTMLButtonElement>('[data-x="cmp"]');
        if (b) b.textContent = "담았습니다 · 다른 동을 하나 더 고르세요";
      } else {
        const a = compareA;
        compareA = null;
        location.hash = `#/compare?a=${a}&b=${code}`;
      }
    });
  }
}

window.addEventListener("hashchange", route);
route();
