import { heatmap, hourLines } from "./charts";
import { colorFor } from "./colors";
import { type Data, type Dong, fmt, loadYear, loadYearsIndex, sortedDongs } from "./data";
import { renderBuildingsSummary } from "./report";

const C1 = "#8fd0ff", C2 = "#f5b041";

export async function renderCompare(root: HTMLElement, data: Data, params: URLSearchParams) {
  const years = await loadYearsIndex();
  let year = Number(params.get("y")) || years[years.length - 1]?.year;
  let yd: Record<string, Dong> = year ? await loadYear(year) : {};
  const list = sortedDongs(data);
  const opt = (sel: string | null) => `<option value="">동 고르기</option>` + list.map((d) => `<option value="${d.code}" ${d.code === sel ? "selected" : ""}>${d.gu} ${d.name}</option>`).join("");
  const a0 = params.get("a"), b0 = params.get("b");
  root.innerHTML = `
  <section class="compare">
    <h2>두 동네 비교</h2>
    <p class="hint">이사 후보 두 곳의 밤 바깥 환경을 나란히 봅니다. 값이 낮을수록 조용합니다.</p>
    <label class="cyear" ${years.length > 1 ? "" : "hidden"}>연도 <select id="cy">${[...years].reverse().map((y) => `<option value="${y.year}" ${y.year === year ? "selected" : ""}>${y.year}년${y.partial ? " (일부)" : ""}</option>`).join("")}</select></label>
    <div class="pick">
      <label><span class="sw" style="background:${C1}"></span>후보 A <select id="ca">${opt(a0)}</select></label>
      <label><span class="sw dash" style="background:${C2}"></span>후보 B <select id="cb">${opt(b0)}</select></label>
    </div>
    <div id="cout"></div>
  </section>`;
  const sa = root.querySelector<HTMLSelectElement>("#ca")!, sb = root.querySelector<HTMLSelectElement>("#cb")!;
  const out = root.querySelector<HTMLElement>("#cout")!;
  const draw = () => {
    history.replaceState(null, "", `#/compare?y=${year}&a=${sa.value}&b=${sb.value}`);
    const fp = document.getElementById("foot-period");
    const yi = years.find((x) => x.year === year);
    if (fp && yi) fp.textContent = `${year}년 · ${yi.start} ~ ${yi.end} 밤 ${yi.nights}일${yi.partial ? " (일부 기간)" : ""}`;
    const pick = (c: string): Dong | undefined => (data.dongs[c] ? ({ ...data.dongs[c], ...(yd[c] ?? { l_night: null }) } as Dong) : undefined);
    const A = pick(sa.value), B = pick(sb.value);
    if (!A || !B) { out.innerHTML = `<p class="empty">두 동을 모두 고르면 비교가 나타납니다.</p>`; return; }
    type Row = [string, (d: Dong) => number | null | undefined, string, number, boolean];
    const rows: Row[] = [
      ["밤 평균 소음", (d) => d.l_night, "dB", 1, true],
      ["수면 점수", (d) => d.score, "/100", 0, false],
      ["피크 횟수", (d) => d.peaks_per_night, "회/밤", 1, true],
      ["밤 밝기", (d) => d.lux, "lux", 1, true],
      ["주말 효과", (d) => d.weekend_effect, "dB", 1, true],
      ["조용한 밤 비율", (d) => (d.quiet_ratio == null ? null : d.quiet_ratio * 100), "%", 0, false],
    ];
    const better = (va: number | null | undefined, vb: number | null | undefined, lowGood: boolean) => {
      if (va == null || vb == null || Math.abs(va - vb) < 1) return [0, 0];
      return (va < vb) === lowGood ? [1, 0] : [0, 1];
    };
    out.innerHTML = `
      <table class="ctable">
        <caption class="sr">두 동네 지표 비교표</caption>
        <thead><tr><th scope="col">지표</th><th scope="col">${A.gu} ${A.name}</th><th scope="col">${B.gu} ${B.name}</th></tr></thead>
        <tbody>
        ${rows.map(([lab, f, u, dg, low]) => {
          const va = f(A), vb = f(B); const [ga, gb] = better(va, vb, low);
          return `<tr><th scope="row">${lab}</th><td class="${ga ? "win" : ""}">${fmt(va, dg)}<small>${u}</small>${ga ? ' <span class="tag-win">더 좋음</span>' : ""}</td>
            <td class="${gb ? "win" : ""}">${fmt(vb, dg)}<small>${u}</small>${gb ? ' <span class="tag-win">더 좋음</span>' : ""}</td></tr>`;
        }).join("")}
        <tr><th scope="row">소음 패턴</th><td>${A.pattern ?? "—"}</td><td>${B.pattern ?? "—"}</td></tr>
        <tr><th scope="row">대표 센서</th><td>${A.n_sensors}개</td><td>${B.n_sensors}개</td></tr>
        </tbody>
      </table>
      <p class="hint">"더 좋음"은 차이가 1 이상일 때만 표시합니다. 소음 1dB 미만 차이는 사람이 거의 구별하지 못합니다.</p>
      <div class="cgrid">
        <section><h3>밤 시간대별 소음</h3><div id="lines" class="chart"></div></section>
        <section><h3><span class="sw" style="background:${C1}"></span>${A.name} 요일×시간</h3><div id="ha" class="chart"></div></section>
        <section><h3><span class="sw" style="background:${C2}"></span>${B.name} 요일×시간</h3><div id="hb" class="chart"></div></section>
        <section id="ba"></section><section id="bb"></section>
      </div>`;
    hourLines(out.querySelector("#lines")!, [
      { label: A.name, color: C1, byHour: A.by_hour }, { label: B.name, color: C2, byHour: B.by_hour },
    ], data.meta.thresholds);
    heatmap(out.querySelector("#ha")!, A.heatmap, `${A.name} 요일×시간 소음`);
    heatmap(out.querySelector("#hb")!, B.heatmap, `${B.name} 요일×시간 소음`);
    renderBuildingsSummary(out.querySelector("#ba")!, data, A.code).then(() => out.querySelector("#ba h3")?.prepend(`${A.name} · `));
    renderBuildingsSummary(out.querySelector("#bb")!, data, B.code).then(() => out.querySelector("#bb h3")?.prepend(`${B.name} · `));
    void colorFor;
  };
  root.querySelector<HTMLSelectElement>("#cy")!.addEventListener("change", async (e) => {
    year = +(e.target as HTMLSelectElement).value;
    yd = await loadYear(year);
    draw();
  });
  sa.addEventListener("change", draw);
  sb.addEventListener("change", draw);
  draw();
}
