import * as d3 from "d3";
import { colorFor, inkFor } from "./colors";
import { DAYS, HOURS, fmt } from "./data";

const TXT = "var(--ink-2)";

/** 값 하나를 30~70dB 축 위에 표시 + WHO 기준선 */
export function dbScale(el: HTMLElement, value: number | null, seoulMedian: number | null, lines: Record<string, number>) {
  el.innerHTML = "";
  const w = 320, h = 74, m = { l: 8, r: 8, t: 22, b: 22 };
  const x = d3.scaleLinear().domain([30, 70]).range([m.l, w - m.r]).clamp(true);
  const svg = d3.select(el).append("svg").attr("viewBox", `0 0 ${w} ${h}`).attr("role", "img")
    .attr("aria-label", `밤 소음 ${fmt(value, 1, "dB")}. WHO 야간 목표 40dB, 도로교통 권고 45dB, 중간 목표 55dB. 서울 행정동 중앙값 ${fmt(seoulMedian, 1, "dB")}.`);
  const grad = d3.range(30, 70.5, 0.5);
  svg.append("g").selectAll("rect").data(grad).join("rect")
    .attr("x", (d) => x(d)).attr("y", m.t + 8).attr("width", x(30.5) - x(30) + 0.5).attr("height", 10).attr("fill", (d) => colorFor(d));
  const ref = [
    { v: lines.who_target, t: "WHO 40" }, { v: lines.who_road, t: "도로 45" }, { v: lines.who_interim, t: "중간 55" },
  ];
  const g = svg.append("g");
  ref.forEach((r) => {
    g.append("line").attr("x1", x(r.v)).attr("x2", x(r.v)).attr("y1", m.t + 2).attr("y2", m.t + 24).attr("stroke", "var(--ink)").attr("stroke-dasharray", "2 2");
    g.append("text").attr("x", x(r.v)).attr("y", m.t - 2).attr("text-anchor", "middle").attr("font-size", 10).attr("fill", TXT).text(r.t);
  });
  if (seoulMedian != null) {
    g.append("path").attr("d", `M${x(seoulMedian)},${m.t + 26} l-4,7 h8 z`).attr("fill", "var(--ink-2)");
    g.append("text").attr("x", x(seoulMedian)).attr("y", h - 2).attr("text-anchor", "middle").attr("font-size", 10).attr("fill", TXT).text("서울 중앙값");
  }
  if (value != null) {
    g.append("circle").attr("cx", x(value)).attr("cy", m.t + 13).attr("r", 7).attr("fill", colorFor(value)).attr("stroke", "#fff").attr("stroke-width", 2.5);
  }
  [30, 50, 70].forEach((v) => svg.append("text").attr("x", x(v)).attr("y", h - 2).attr("text-anchor", v === 30 ? "start" : v === 70 ? "end" : "middle")
    .attr("font-size", 10).attr("fill", TXT).text(v === 70 ? "70dB" : String(v)));
}

/** 요일×시간 히트맵 (7×24) */
export function heatmap(el: HTMLElement, hm: (number | null)[][] | undefined, title: string) {
  el.innerHTML = "";
  if (!hm) { el.textContent = "데이터 없음"; return; }
  const cell = 13, ml = 22, mt = 16, w = ml + cell * 24 + 4, h = mt + cell * 7 + 18;
  let max = { v: -1, d: 0, h: 0 }, min = { v: 999, d: 0, h: 0 };
  hm.forEach((row, di) => row.forEach((v, hi) => {
    if (v == null) return;
    if (v > max.v) max = { v, d: di, h: hi };
    if (v < min.v) min = { v, d: di, h: hi };
  }));
  const svg = d3.select(el).append("svg").attr("viewBox", `0 0 ${w} ${h}`).attr("role", "img")
    .attr("aria-label", `${title}. 가장 시끄러운 때 ${DAYS[max.d]}요일 ${max.h}시 ${fmt(max.v, 0, "dB")}, 가장 조용한 때 ${DAYS[min.d]}요일 ${min.h}시 ${fmt(min.v, 0, "dB")}.`);
  // 밤 구간 표시
  [[22, 24], [0, 6]].forEach(([a, b]) => svg.append("rect").attr("x", ml + a * cell - 1).attr("y", mt - 3).attr("width", (b - a) * cell + 2)
    .attr("height", cell * 7 + 5).attr("fill", "none").attr("stroke", "var(--accent)").attr("stroke-width", 1.2).attr("rx", 2));
  const tip = svg.append("title");
  hm.forEach((row, di) => {
    svg.append("text").attr("x", ml - 5).attr("y", mt + di * cell + cell - 3).attr("text-anchor", "end").attr("font-size", 10).attr("fill", TXT).text(DAYS[di]);
    row.forEach((v, hi) => {
      svg.append("rect").attr("x", ml + hi * cell).attr("y", mt + di * cell).attr("width", cell - 1).attr("height", cell - 1)
        .attr("fill", colorFor(v)).append("title").text(`${DAYS[di]} ${hi}시~${hi + 1}시: ${fmt(v, 1, "dB")}`);
    });
  });
  tip.text(title);
  [0, 6, 12, 18, 23].forEach((hh) => svg.append("text").attr("x", ml + hh * cell + cell / 2).attr("y", mt - 5).attr("text-anchor", "middle")
    .attr("font-size", 9).attr("fill", TXT).text(hh + "시"));
  svg.append("text").attr("x", ml).attr("y", h - 3).attr("font-size", 9.5).attr("fill", TXT).text("테두리 = 밤(22~06시) · 칸 = 그 시간 1시간 평균(에너지 평균, dB)");
}

/** 밤 시간대별 선 그래프 (여러 동 겹치기) */
export function hourLines(el: HTMLElement, series: { label: string; color: string; byHour?: Record<string, number | null> }[], lines: Record<string, number>) {
  el.innerHTML = "";
  const w = 360, h = 200, m = { l: 34, r: 10, t: 12, b: 28 };
  const x = d3.scalePoint<number>().domain(HOURS).range([m.l, w - m.r]);
  const vals = series.flatMap((s) => HOURS.map((hh) => s.byHour?.[String(hh)] ?? null)).filter((v): v is number => v != null);
  const lo = Math.min(35, ...vals) - 1, hi = Math.max(58, ...vals) + 1;
  const y = d3.scaleLinear().domain([lo, hi]).range([h - m.b, m.t]);
  const desc = series.map((s) => `${s.label}: ` + HOURS.map((hh) => `${hh}시 ${fmt(s.byHour?.[String(hh)], 0)}`).join(", ")).join(" / ");
  const svg = d3.select(el).append("svg").attr("viewBox", `0 0 ${w} ${h}`).attr("role", "img").attr("aria-label", `밤 시간대별 소음(dB). ${desc}`);
  svg.append("g").attr("transform", `translate(0,${h - m.b})`).call(d3.axisBottom(x).tickFormat((d) => `${d}시`)).attr("color", "var(--ink-2)");
  svg.append("g").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(5)).attr("color", "var(--ink-2)");
  svg.append("text").attr("x", 4).attr("y", m.t - 2).attr("font-size", 10).attr("fill", TXT).text("dB");
  [lines.who_target, lines.who_road, lines.who_interim].forEach((v) => {
    if (v < lo || v > hi) return;
    svg.append("line").attr("x1", m.l).attr("x2", w - m.r).attr("y1", y(v)).attr("y2", y(v)).attr("stroke", "var(--ink-2)").attr("stroke-dasharray", "3 3");
    svg.append("text").attr("x", w - m.r).attr("y", y(v) - 3).attr("text-anchor", "end").attr("font-size", 9.5).attr("fill", TXT).text(`WHO ${v}`);
  });
  series.forEach((s, i) => {
    const pts = HOURS.map((hh) => [x(hh)!, s.byHour?.[String(hh)] ?? null] as [number, number | null]);
    const line = d3.line<[number, number | null]>().defined((d) => d[1] != null).x((d) => d[0]).y((d) => y(d[1] as number));
    svg.append("path").attr("d", line(pts)).attr("fill", "none").attr("stroke", s.color).attr("stroke-width", 2.5).attr("stroke-dasharray", i === 1 ? "6 3" : null);
    pts.forEach(([px, v]) => v != null && svg.append("circle").attr("cx", px).attr("cy", y(v)).attr("r", 3).attr("fill", s.color).append("title").text(`${s.label} ${fmt(v, 1, "dB")}`));
  });
}

/** 조용한 밤 달력: 주(열) × 요일(행) */
export function calendar(el: HTMLElement, nights: Record<string, number | null> | undefined, quietDb: number) {
  el.innerHTML = "";
  if (!nights || !Object.keys(nights).length) { el.textContent = "데이터 없음"; return; }
  const dates = Object.keys(nights).sort();
  const first = new Date(dates[0] + "T00:00:00"), last = new Date(dates[dates.length - 1] + "T00:00:00");
  const mon = (dt: Date) => { const d = new Date(dt); d.setDate(d.getDate() - ((d.getDay() + 6) % 7)); return d; };
  const start = mon(first);
  const weeks = Math.floor((+last - +start) / (7 * 864e5)) + 1;
  const cell = 18, ml = 22, mt = 18, w = Math.max(ml + weeks * cell + 4, 160), h = mt + 7 * cell + 4;
  const quiet = dates.filter((d) => (nights[d] ?? 99) < quietDb);
  const svg = d3.select(el).append("svg").attr("viewBox", `0 0 ${w} ${h}`).attr("role", "img")
    .attr("aria-label", `${dates.length}일 밤 중 ${quiet.length}일이 ${quietDb}dB 미만인 조용한 밤. 조용한 밤: ${quiet.join(", ") || "없음"}`)
    .style("max-width", `${w * 1.6}px`);
  DAYS.forEach((d, i) => svg.append("text").attr("x", ml - 5).attr("y", mt + i * cell + cell - 5).attr("text-anchor", "end").attr("font-size", 10).attr("fill", TXT).text(d));
  let lastMonth = -1;
  for (const ds of dates) {
    const dt = new Date(ds + "T00:00:00");
    const wi = Math.floor((+mon(dt) - +start) / (7 * 864e5)), di = (dt.getDay() + 6) % 7;
    const v = nights[ds];
    const q = v != null && v < quietDb;
    const gx = ml + wi * cell, gy = mt + di * cell;
    const g = svg.append("g");
    g.append("rect").attr("x", gx).attr("y", gy).attr("width", cell - 2).attr("height", cell - 2).attr("rx", 3)
      .attr("fill", q ? "var(--quiet)" : "var(--panel-2)").attr("stroke", q ? "none" : "var(--line)");
    g.append("text").attr("x", gx + (cell - 2) / 2).attr("y", gy + cell - 6).attr("text-anchor", "middle").attr("font-size", 8.5)
      .attr("fill", q ? inkFor("#9fd3c7") : "var(--ink-2)").text(dt.getDate());
    g.append("title").text(`${ds} 밤(22시~다음날 6시): ${fmt(v, 1, "dB")}${q ? " · 조용한 밤" : ""}`);
    if (dt.getMonth() !== lastMonth && di <= 3) {
      svg.append("text").attr("x", gx).attr("y", mt - 6).attr("font-size", 10).attr("fill", TXT).text(`${dt.getMonth() + 1}월`);
      lastMonth = dt.getMonth();
    }
  }
}

/** 연도별 밤 소음 추이: 이 동(선) + 서울 행정동 중앙값(점선) */
export function yearTrend(el: HTMLElement, dong: { year: number; v: number | null; partial: boolean }[],
  seoul: { year: number; v: number | null }[], lines: Record<string, number>, selected?: number) {
  el.innerHTML = "";
  const years = dong.map((d) => d.year);
  if (!years.length) { el.textContent = "연도별 자료가 아직 없습니다."; return; }
  const w = 360, h = 190, m = { l: 34, r: 12, t: 14, b: 28 };
  const x = d3.scalePoint<number>().domain(years).range([m.l, w - m.r]).padding(0.4);
  const vals = [...dong.map((d) => d.v), ...seoul.map((d) => d.v)].filter((v): v is number => v != null);
  const lo = Math.min(38, ...vals) - 1, hi = Math.max(50, ...vals) + 1;
  const y = d3.scaleLinear().domain([lo, hi]).range([h - m.b, m.t]);
  const desc = dong.map((d) => `${d.year}년 ${fmt(d.v, 1)}dB${d.partial ? "(부분)" : ""}`).join(", ");
  const svg = d3.select(el).append("svg").attr("viewBox", `0 0 ${w} ${h}`).attr("role", "img").attr("aria-label", `연도별 밤 소음: ${desc}`);
  svg.append("g").attr("transform", `translate(0,${h - m.b})`).call(d3.axisBottom(x).tickFormat((d) => `${d}`)).attr("color", "var(--ink-2)");
  svg.append("g").attr("transform", `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(5)).attr("color", "var(--ink-2)");
  svg.append("text").attr("x", 4).attr("y", m.t - 2).attr("font-size", 10).attr("fill", TXT).text("dB");
  [lines.who_target, lines.who_road].forEach((v) => {
    if (v < lo || v > hi) return;
    svg.append("line").attr("x1", m.l).attr("x2", w - m.r).attr("y1", y(v)).attr("y2", y(v)).attr("stroke", "var(--ink-2)").attr("stroke-dasharray", "3 3").attr("opacity", 0.6);
  });
  if (selected != null && years.includes(selected)) {
    svg.append("rect").attr("x", x(selected)! - 14).attr("y", m.t).attr("width", 28).attr("height", h - m.b - m.t).attr("fill", "var(--panel-2)");
  }
  const line = d3.line<{ year: number; v: number | null }>().defined((d) => d.v != null).x((d) => x(d.year)!).y((d) => y(d.v as number));
  svg.append("path").attr("d", line(seoul)).attr("fill", "none").attr("stroke", "var(--ink-2)").attr("stroke-width", 1.5).attr("stroke-dasharray", "5 4");
  svg.append("path").attr("d", line(dong)).attr("fill", "none").attr("stroke", "var(--accent)").attr("stroke-width", 2.5);
  dong.forEach((d) => d.v != null && svg.append("circle").attr("cx", x(d.year)!).attr("cy", y(d.v)).attr("r", 4)
    .attr("fill", d.partial ? "var(--panel)" : colorFor(d.v)).attr("stroke", "var(--accent)").attr("stroke-width", 2)
    .append("title").text(`${d.year}년 ${fmt(d.v, 1, "dB")}${d.partial ? " (일부 기간)" : ""}`));
}
