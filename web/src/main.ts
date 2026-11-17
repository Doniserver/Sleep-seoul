import "./style.css";
import { type Data, loadCore } from "./data";
import { renderMap } from "./mapview";

const main = document.getElementById("main")!;
const footer = document.getElementById("footer")!;
let cleanup: (() => void) | void;

function footerHtml(d: Data) {
  const m = d.meta;
  return `<p><b>출처</b> · ${m.sources.map((s) => `<a href="${s.url}" target="_blank" rel="noopener">${s.name}</a> (${s.by})`).join(" · ")} ·
  <a href="https://www.data.go.kr/data/15146878/fileData.do" target="_blank" rel="noopener">국토지리정보원 연속수치지형도 도로중심선</a> (브이월드 공간정보 다운로드, 공공누리 1유형) ·
  소상공인시장진흥공단 상가(상권)정보 (공공데이터포털) · 배경지도·항공사진·실사 3D·장소 찾기 © <a href="https://www.vworld.kr" target="_blank" rel="noopener">브이월드</a>(국토교통부)</p>
  <p><b>자료 기간</b> <span id="foot-period">가장 최근에 끝난 한 해</span> ·
  집 밖 소음을 길가 센서(간이측정기)의 측정값과 주변 도로·가게로 추정한 값입니다. 집 안 소음과는 다르며, 참고용입니다.</p>`;
}

async function route() {
  if (cleanup) cleanup();
  cleanup = undefined;
  const qs = (location.hash.replace(/^#\/?/, "") || "map").split("?")[1];
  const params = new URLSearchParams(qs ?? "");
  main.innerHTML = `<p class="loading">불러오는 중…</p>`;
  let data: Data;
  try {
    data = await loadCore();
  } catch (e) {
    main.innerHTML = `<p class="empty">데이터를 불러오지 못했습니다. (${String(e)})</p>`;
    return;
  }
  footer.innerHTML = footerHtml(data);
  document.body.dataset.route = "map";
  document.title = "잠 잘 오는 동네";
  cleanup = renderMap(main, data, params);       // 화면은 지도 하나뿐이다 (다른 주소로 들어와도 지도를 보여 준다)
}

window.addEventListener("hashchange", route);
route();
