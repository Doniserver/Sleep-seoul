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

// ── 생활시설 (상가정보) ─────────────────────────────────────
export interface PlaceCategory { key: string; name: string; default: boolean }
export interface PlacesSummary {
  stdrYm: string; total: number; categories: PlaceCategory[];
  seoul_median: Record<string, number>; dongs: Record<string, Record<string, number>>;
  source: { name: string; url: string };
}
/** [위도, 경도, 건물명, [[분류번호, 상호, 층, 업종], ...]] */
export type PlaceBuilding = [number, number, string, [number, string, string, string][]];

let placesSummary: PlacesSummary | null | undefined;
export async function loadPlacesSummary(): Promise<PlacesSummary | null> {
  if (placesSummary === undefined) {
    try { placesSummary = await j<PlacesSummary>("places_summary.json"); } catch { placesSummary = null; }
  }
  return placesSummary;
}
const placeCache = new Map<string, Promise<PlaceBuilding[]>>();
export function loadPlaces(code: string): Promise<PlaceBuilding[]> {
  if (!placeCache.has(code)) placeCache.set(code, j<PlaceBuilding[]>(`places/${code}.json`).catch(() => []));
  return placeCache.get(code)!;
}

// 분류 색 (서로 잘 구분되는 색, 소음 색과 섞이지 않게 흰 테두리와 함께 사용)
export const PLACE_COLORS: Record<string, string> = {
  food: "#ff7f50", cafe: "#d4a373", bar: "#e056a0", hospital: "#ff4d5e", pharmacy: "#4cd18a", mart: "#3fa9f5",
  gym: "#a77bf3", academy: "#f5d142", leisure: "#2ec4b6", life: "#f49fbc", office: "#b8c1cc", etc: "#7b8494",
};
