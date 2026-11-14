import { calendar, dbScale, heatmap, yearTrend } from "./charts";
import { colorFor, levelBadge, levelWord } from "./colors";
import { type Data, type Dong, fmt, loadBuildings, loadCalendar, loadTrends, loadYearCalendar, loadYearsIndex } from "./data";

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

export async function renderReport(el: HTMLElement, data: Data, d: Dong, opts: { onCompare?: (code: string) => void; year?: number | null; periodLabel?: string; range?: { label: string; value: number | null }; shift?: number; median?: number | null; rank?: { n: number; of: number } } = {}) {
  const t = data.meta.thresholds;
  const pat = data.patterns.find((p) => p.name === d.pattern);
  if (d.l_night == null) {
    el.innerHTML = `<h2>${esc(d.gu)} ${esc(d.name)}</h2>
      <p class="empty">이 동에는 쓸 수 있는 센서가 없어 값을 계산하지 않았습니다. 주변 동 값으로 메우지 않습니다.</p>`;
    return;
  }
  const floorNote = d.l_night <= t.noise_floor + 0.5 ? `<p class="hint">센서가 잴 수 있는 가장 작은 값이 ${t.noise_floor}dB라서, 실제로는 이보다 더 조용할 수 있습니다.</p>` : "";
  // 큰 숫자 하나: 지금 고른 시간대(밤 또는 낮)의 값. 나머지 분석은 '자세히 보기' 안에 접어 둔다
  const main = opts.range ? opts.range.value : d.l_night;
  const when = opts.range ? opts.range.label : "밤(22~06시)";
  const lv = levelWord(main, undefined, opts.shift ?? 0);
  const diff = main != null && opts.median != null ? main - opts.median : null;
  const versus = diff == null ? "" : Math.abs(diff) < 1 ? "서울 동네들의 중간과 비슷합니다." : `서울 동네들의 중간보다 <b>${Math.abs(diff).toFixed(1)}dB ${diff > 0 ? "시끄럽습니다" : "조용합니다"}</b>.`;
  el.innerHTML = `
    <div class="rhead">
      <h2>${esc(d.gu)} <span>${esc(d.name)}</span></h2>
    </div>
    <div class="big">
      <div><span class="chip" style="background:${colorFor(main == null ? null : main - (opts.shift ?? 0))}" aria-hidden="true"></span><span class="num">${fmt(main)}</span><span class="unit">dB</span> ${levelBadge(lv)}
        <p class="lbl">${esc(when)} 동네 바깥 소음${opts.year ? ` · ${opts.year}년` : ""}</p></div>
    </div>
    ${versus ? `<p class="plain">${versus}</p>` : ""}
    ${opts.rank ? `<p class="plain">서울 ${opts.rank.of}개 동네 가운데 <b>${opts.rank.n}번째</b>로 조용합니다.</p>` : ""}
    <p class="plain">잠자기 좋은 정도 <b>${d.score ?? "—"}점</b> / 100점${scoreWord(d.score) ? ` · ${scoreWord(d.score)}` : ""} <span class="sub">(밤 소음 기준)</span></p>
    <p class="hint">길가 센서 ${d.n_sensors}곳이 잰 값${d.n_sensors > 1 ? "의 가운데 값" : ""}입니다.${d.n_sensors === 1 ? " 센서가 1곳뿐이라 그 자리의 영향을 크게 받습니다." : ""} 센서가 달린 자리의 값이라, 같은 동네 안에서도 큰길가는 더 시끄럽고 골목 안쪽은 더 조용할 수 있습니다.</p>
    ${opts.onCompare ? `<div class="actions"><button type="button" data-x="cmp">다른 동네와 비교하기</button></div>` : ""}
    <details class="more-report">
      <summary>자세히 보기</summary>
      ${pat ? `<p class="plain"><b>${esc(pat.name)}</b> · ${esc(pat.desc)}</p>` : ""}
      <h3>세계보건기구(WHO) 기준과 견주기 <small>밤 소음</small></h3>
      <div class="scale" data-x="scale"></div>
      <ul class="who">
        <li>WHO 야간 목표(집 밖 40dB): ${whoDiff(d.l_night, t.who_target)}</li>
        <li>WHO 중간 목표(55dB): ${whoDiff(d.l_night, t.who_interim)}</li>
      </ul>
      ${floorNote}
      <dl class="stats">
        <div><dt>조용한 밤</dt><dd>${d.quiet_ratio == null ? "—" : Math.round(d.quiet_ratio * 100)}<small>%</small></dd><dd class="s">1년 중 ${t.quiet_night}dB보다 조용했던 밤</dd></div>
        <div><dt>주말에 더 시끄러운 정도</dt><dd>${d.weekend_effect == null ? "—" : (d.weekend_effect > 0 ? "+" : "") + d.weekend_effect.toFixed(1)}<small>dB</small></dd><dd class="s">금·토 밤 − 일~목 밤</dd></div>
        <div><dt>크게 시끄러웠던 시간</dt><dd>${fmt(d.peaks_per_night, 1)}<small>회/밤</small></dd><dd class="s">한 시간 중 최대값이 ${t.peak}dB를 넘음</dd></div>
        <div><dt>밤 밝기</dt><dd>${fmt(d.lux, 1)}<small>lux</small></dd><dd class="s">참고선 ${t.lux_ref} lux ${d.lux != null ? (d.lux > t.lux_ref ? "· 넘음" : "· 이하") : ""}</dd></div>
      </dl>
      ${d.report ? `<section class="ai" aria-label="AI 한 줄 리포트"><h3>AI 한 줄 리포트</h3><p>${esc(d.report.text)}</p><p class="hint">AI가 문장만 만들고 숫자는 데이터에서 가져와 자동 검증했습니다 (${esc(d.report.generated_at)}).</p></section>` : ""}
      <h3>요일과 시간에 따른 소음 <small>밝을수록 시끄러움</small></h3><div data-x="heat" class="chart"></div>
      <h3>조용했던 밤 달력 <small>초록 = ${t.quiet_night}dB보다 조용했던 밤</small></h3><div data-x="cal" class="chart"></div>
      <section data-x="trendbox" hidden><h3>연도별 밤 소음 <small>(주황 = 이 동, 점선 = 서울 행정동 중앙값, 빈 점 = 일부 기간)</small></h3><div data-x="trend" class="chart"></div></section>
      <section data-x="bld"></section>
      ${opts.periodLabel ? `<p class="hint">자료 기간: ${esc(opts.periodLabel)} · <a href="#/method">계산 방법과 한계</a></p>` : ""}
    </details>
  `;
  const q = (k: string) => el.querySelector<HTMLElement>(`[data-x="${k}"]`)!;
  dbScale(q("scale"), d.l_night, data.meta.seoul.l_night_median, t);
  heatmap(q("heat"), d.heatmap, `${d.name} 요일×시간 소음`);
  if (opts.onCompare) q("cmp").addEventListener("click", () => opts.onCompare!(d.code));
  const cal = opts.year ? await loadYearCalendar(opts.year) : await loadCalendar(data);
  calendar(q("cal"), cal[d.code], t.quiet_night);
  const idx = await loadYearsIndex();
  const tr = idx.length > 1 ? await loadTrends() : {};   // 해가 하나뿐이면 추이 파일이 없으므로 받지 않는다
  if (idx.length > 1) q("trendbox").hidden = false;   // 해가 하나뿐이면 추이 그림은 보이지 않는다
  if (idx.length > 1)
    yearTrend(q("trend"), idx.map((y) => ({ year: y.year, v: tr[d.code]?.[String(y.year)] ?? null, partial: y.partial })),
    idx.map((y) => ({ year: y.year, v: y.seoul_median })), t, opts.year ?? undefined);
  await renderBuildingsSummary(q("bld"), data, d.code);
}

export async function renderBuildingsSummary(el: HTMLElement, data: Data, code: string) {
  const b = await loadBuildings(data);
  if (!b) { el.innerHTML = ""; return; }   // 건물 자료가 아직 없으면 자리를 차지하지 않는다
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
