export interface MonthStat { l_night: number | null; nights: number; score: number | null }

export interface Dong {
  code: string;
  name: string;
  gu: string;
  n_sensors: number;
  basis: string | null;
  report: { text: string; generated_at: string; method: string; verified: boolean } | null;
  l_night: number | null;
  sensors?: string[];
  peaks_per_night?: number | null;
  lux?: number | null;
  weekend_effect?: number | null;
  score?: number | null;
  by_hour?: Record<string, number | null>;
  heatmap?: (number | null)[][];
  quiet_ratio?: number | null;
  months?: Record<string, MonthStat>;
  pattern?: string;
}

export interface Pattern { id: number; name: string; desc: string; n: number; level_db: number; profile: number[] }

export interface Meta {
  generated_at: string;
  period: { start: string; end: string; nights: number };
  months: string[];
  counts: Record<string, number>;
  seoul: { l_night_median: number | null; l_night_min: number | null; l_night_max: number | null };
  thresholds: Record<string, number>;
  sources: { name: string; by: string; url: string }[];
  has_buildings?: boolean;
}

export interface Sensor { sn: string; lat: number; lon: number; rgn: string; rgn_ko: string; adm: string | null; used: boolean; noise_ok: boolean; l_night: number | null }

export interface Building {
  name: string; code: string; lat: number | null; lon: number | null; adm: string | null;
  use_date: string | null; year: number | null; grade: string | null; households: number | null; structure: string | null;
}

export interface BuildingsFile {
  generated_at: string; source: string; complexes: Building[];
  by_dong: Record<string, Record<string, number>>; bjd_of_dong: Record<string, string>;
}

export interface Data {
  meta: Meta;
  dongs: Record<string, Dong>;
  geo: GeoJSON.FeatureCollection;
  patterns: Pattern[];
  calendar?: Record<string, Record<string, number | null>>;
  sensors?: Sensor[];
  buildings?: BuildingsFile | null;
}

const base = import.meta.env.BASE_URL + "data/";

async function j<T>(name: string): Promise<T> {
  const r = await fetch(base + name);
  if (!r.ok) throw new Error(`${name}: ${r.status}`);
  return r.json() as Promise<T>;
}

let cache: Data | null = null;

export async function loadCore(): Promise<Data> {
  if (cache) return cache;
  const [meta, dongs, geo, patterns] = await Promise.all([
    j<Meta>("meta.json"), j<Record<string, Dong>>("dongs_stats.json"),
    j<GeoJSON.FeatureCollection>("dongs.geojson"), j<Pattern[]>("patterns.json"),
  ]);
  cache = { meta, dongs, geo, patterns };
  return cache;
}

export async function loadCalendar(d: Data) {
  if (!d.calendar) d.calendar = await j("calendar.json");
  return d.calendar!;
}

export async function loadSensors(d: Data) {
  if (!d.sensors) d.sensors = await j("sensors.json");
  return d.sensors!;
}

export async function loadBuildings(d: Data) {
  if (d.buildings === undefined) {
    if (!d.meta.has_buildings) { d.buildings = null; return null; }
    try { d.buildings = await j<BuildingsFile>("buildings.json"); } catch { d.buildings = null; }
  }
  return d.buildings;
}

export const HOURS = [22, 23, 0, 1, 2, 3, 4, 5];
export const DAYS = ["월", "화", "수", "목", "금", "토", "일"];

export function fmt(v: number | null | undefined, digits = 1, unit = ""): string {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  return v.toFixed(digits) + unit;
}

export function sortedDongs(d: Data): Dong[] {
  return Object.values(d.dongs).sort((a, b) => (a.gu + a.name).localeCompare(b.gu + b.name, "ko"));
}

// ── 연도별 (pipeline/yearly.py) ─────────────────────────────
export interface YearInfo {
  year: number; start: string | null; end: string | null; nights: number; partial: boolean;
  sensors_used: number; dongs_with_data: number; seoul_median: number | null;
}
let yearsIndex: YearInfo[] | null | undefined;
export async function loadYearsIndex(): Promise<YearInfo[]> {
  if (yearsIndex === undefined) {
    try { yearsIndex = await j<YearInfo[]>("years/index.json"); } catch { yearsIndex = null; }
  }
  return yearsIndex ?? [];
}
const yearCache = new Map<number, Promise<Record<string, Dong>>>();
export function loadYear(y: number) {
  if (!yearCache.has(y)) yearCache.set(y, j<Record<string, Dong>>(`years/${y}.json`));
  return yearCache.get(y)!;
}
const yearCalCache = new Map<number, Promise<Record<string, Record<string, number | null>>>>();
/** 연도 달력 {start, days, dongs:{동:[값]}} → {동: {날짜: 값}} */
export function loadYearCalendar(y: number) {
  if (!yearCalCache.has(y)) {
    yearCalCache.set(y, j<{ start: string | null; days: number; dongs: Record<string, (number | null)[]> }>(`years/${y}_calendar.json`).then((c) => {
      const out: Record<string, Record<string, number | null>> = {};
      if (!c.start) return out;
      const t0 = new Date(c.start + "T00:00:00");
      const dates = Array.from({ length: c.days }, (_, i) => {
        const d = new Date(t0); d.setDate(d.getDate() + i);
        return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
      });
      for (const [code, arr] of Object.entries(c.dongs)) {
        const m: Record<string, number | null> = {};
        arr.forEach((v, i) => { if (v != null) m[dates[i]] = v; });
        out[code] = m;
      }
      return out;
    }));
  }
  return yearCalCache.get(y)!;
}
let trends: Record<string, Record<string, number | null>> | null | undefined;
export async function loadTrends() {
  if (trends === undefined) {
    try { trends = await j("years/trends.json"); } catch { trends = null; }
  }
  return trends ?? {};
}
