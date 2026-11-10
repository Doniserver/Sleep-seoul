import { calendar, dbScale, heatmap } from "./charts";
import { colorFor } from "./colors";
import { type Data, type Dong, fmt, loadBuildings, loadCalendar, loadPlacesSummary } from "./data";
import { placeSummaryHtml } from "./places-layer";

function esc(s: string) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

export function whoDiff(v: number | null, ref: number): string {
  if (v == null) return "—";
  const d = v - ref;
  if (Math.abs(d) < 0.05) return `${ref}dB와 같음`;
  return d > 0 ? `${ref}dB보다 <b>${d.toFixed(1)}dB 높음</b>` : `${ref}dB보다 ${(-d).toFixed(1)}dB 낮음`;
}

function scoreWord(s: number | null | undefined) {
  if (s == null) return "";
  return s >= 85 ? "아주 좋음" : s >= 65 ? "좋음" : s >= 40 ? "보통" : "나쁨";
}

export async function renderReport(el: HTMLElement, data: Data, d: Dong, opts: { onCompare?: (code: string) => void } = {}) {
  const t = data.meta.thresholds;
  const pat = data.patterns.find((p) => p.name === d.pattern);
  if (d.l_night == null) {
    el.innerHTML = `<h2>${esc(d.gu)} ${esc(d.name)}</h2><div data-x="facil"></div>
      <h3 class="sec">밤 바깥 소음</h3>
      <p class="empty">이 동에는 쓸 수 있는 센서가 없어 값을 계산하지 않았습니다. 주변 동 값으로 메우지 않습니다.</p>`;
    const sum = await loadPlacesSummary();
    if (sum) el.querySelector<HTMLElement>('[data-x="facil"]')!.innerHTML = placeSummaryHtml(sum, d.code);
    return;
  }
  const floorNote = d.l_night <= t.noise_floor + 0.5 ? `<p class="hint">센서가 잴 수 있는 가장 작은 값이 ${t.noise_floor}dB라서, 실제로는 이보다 더 조용할 수 있습니다.</p>` : "";
  el.innerHTML = `
    <div class="rhead">
      <h2>${esc(d.gu)} <span>${esc(d.name)}</span></h2>
      ${pat ? `<span class="badge" title="${esc(pat.desc)}">${esc(pat.name)}</span>` : ""}
    </div>
    <div data-x="facil"></div>
    <h3 class="sec">밤 바깥 소음</h3>
    <div class="big">
      <div><span class="chip" style="background:${colorFor(d.l_night)}" aria-hidden="true"></span><span class="num">${fmt(d.l_night)}</span><span class="unit">dB</span>
        <p class="lbl">밤(22~06시) 평균 소음 · 에너지 평균</p></div>
      <div class="score"><span class="num">${d.score ?? "—"}</span><span class="unit">/100</span>
        <p class="lbl">수면 점수 ${scoreWord(d.score)} <a href="#/method" class="mini">산식</a></p></div>
    </div>
    <div class="scale" data-x="scale"></div>
    <ul class="who">
      <li>WHO 야간 목표(집 밖 40dB): ${whoDiff(d.l_night, t.who_target)}</li>
      <li>WHO 중간 목표(55dB): ${whoDiff(d.l_night, t.who_interim)}</li>
    </ul>
    ${floorNote}
    <dl class="stats">
      <div><dt>피크 횟수</dt><dd>${fmt(d.peaks_per_night, 1)}<small>회/밤</small></dd><dd class="s">시간 최대값이 ${t.peak}dB를 넘은 시간</dd></div>
      <div><dt>밤 밝기</dt><dd>${fmt(d.lux, 1)}<small>lux</small></dd><dd class="s">참고선 ${t.lux_ref} lux ${d.lux != null ? (d.lux > t.lux_ref ? "· 넘음" : "· 이하") : ""}</dd></div>
      <div><dt>주말 효과</dt><dd>${d.weekend_effect == null ? "—" : (d.weekend_effect > 0 ? "+" : "") + d.weekend_effect.toFixed(1)}<small>dB</small></dd><dd class="s">금·토 밤 − 일~목 밤</dd></div>
      <div><dt>조용한 밤</dt><dd>${d.quiet_ratio == null ? "—" : Math.round(d.quiet_ratio * 100)}<small>%</small></dd><dd class="s">${t.quiet_night}dB 미만인 밤의 비율</dd></div>
    </dl>
    <p class="hint">대표 센서 ${d.n_sensors}개 (${esc(d.basis ?? "")})의 중앙값${d.n_sensors === 1 ? " · <b>센서가 1개뿐이라 그 센서 위치의 영향을 크게 받습니다</b>" : ""}.</p>
    <section class="ai" aria-label="AI 한 줄 리포트">
      <h3>AI 한 줄 리포트</h3>
      ${d.report ? `<p>${esc(d.report.text)}</p><p class="hint">AI가 문장만 만들고 숫자는 데이터에서 가져와 자동 검증했습니다 (${esc(d.report.generated_at)}).</p>`
                : `<p class="hint">준비 중입니다. 숫자는 데이터에서 가져오고, AI는 문장만 만들 예정입니다.</p>`}
    </section>
    <section><h3>요일 × 시간 소음</h3><div data-x="heat" class="chart"></div></section>
    <section><h3>조용한 밤 달력 <small>(${t.quiet_night}dB 미만인 밤 = 초록)</small></h3><div data-x="cal" class="chart"></div></section>
    <section data-x="bld"></section>
    ${opts.onCompare ? `<div class="actions"><button type="button" data-x="cmp">이 동네를 비교에 담기</button></div>` : ""}
  `;
  const q = (k: string) => el.querySelector<HTMLElement>(`[data-x="${k}"]`)!;
  loadPlacesSummary().then((sum) => { if (sum) q("facil").innerHTML = placeSummaryHtml(sum, d.code); });
  dbScale(q("scale"), d.l_night, data.meta.seoul.l_night_median, t);
  heatmap(q("heat"), d.heatmap, `${d.name} 요일×시간 소음`);
  if (opts.onCompare) q("cmp").addEventListener("click", () => opts.onCompare!(d.code));
  const cal = await loadCalendar(data);
  calendar(q("cal"), cal[d.code], t.quiet_night);
  await renderBuildingsSummary(q("bld"), data, d.code);
}

export async function renderBuildingsSummary(el: HTMLElement, data: Data, code: string) {
  const b = await loadBuildings(data);
  if (!b) {
    el.innerHTML = `<h3>층간소음 위험(추정)</h3><p class="hint">건물 데이터 준비 중입니다.</p>`;
    return;
  }
  const s = b.by_dong[code];
  const order = ["높음", "보통", "낮음", "측정 기준 적용"];
  if (!s) { el.innerHTML = `<h3>층간소음 위험(추정)</h3><p class="hint">이 동에서 확인된 공동주택 단지가 없습니다.</p>`; return; }
  const total = order.reduce((a, k) => a + (s[k] ?? 0), 0);
  el.innerHTML = `<h3>층간소음 위험 <span class="est">추정</span></h3>
    <div class="gradebar" role="img" aria-label="${order.map((k) => `${k} ${s[k] ?? 0}개`).join(", ")}">
      ${order.map((k) => (s[k] ? `<span class="g-${order.indexOf(k)}" style="flex:${s[k]}">${k} ${s[k]}</span>` : "")).join("")}
    </div>
    <p class="hint">법정동 <b>${esc(b.bjd_of_dong[code] ?? "")}</b> 전체의 공동주택 단지 ${total}개(K-APT 등록 단지)를 사용승인일로 나눈 등급입니다. 건축 시기 기준 추정 등급이며 실제 소음과 다를 수 있습니다.</p>`;
}
