// 건물·장소 검색: Photon(OpenStreetMap 기반, 키 없음) → 좌표 → 행정동 + 가까운 센서
import type { Data, Sensor } from "./data";

export interface Place { name: string; addr: string; lon: number; lat: number }

const SEOUL_BBOX = [126.76, 37.41, 127.19, 37.72]; // minLon, minLat, maxLon, maxLat
const PHOTON = "https://photon.komoot.io/api/";

async function photon(q: string): Promise<Place[]> {
  const u = `${PHOTON}?q=${encodeURIComponent(q)}&limit=8&bbox=${SEOUL_BBOX.join(",")}`;
  const r = await fetch(u);
  if (!r.ok) throw new Error(`장소 검색 실패 (${r.status})`);
  const j = await r.json();
  const out: Place[] = [];
  for (const f of j.features ?? []) {
    const p = f.properties ?? {};
    const [lon, lat] = f.geometry?.coordinates ?? [];
    if (typeof lon !== "number" || typeof lat !== "number") continue;
    const addr = [p.district, p.street, p.housenumber].filter(Boolean).join(" ");
    const name = p.name ?? p.street ?? q;
    // 같은 이름이 50m 안에 겹치면 하나만
    if (out.some((o) => o.name === name && dist(o.lon, o.lat, lon, lat) < 50)) continue;
    out.push({ name, addr, lon, lat });
  }
  return out;
}

/** 결과가 없으면 앞 단어를 하나씩 떼고 다시 찾는다. 예: "서울대 호암교수회관" → "호암교수회관" */
export async function searchPlaces(query: string, data: Data): Promise<{ places: Place[]; used: string }> {
  const words = query.trim().split(/\s+/);
  for (let i = 0; i < words.length; i++) {
    const q = words.slice(i).join(" ");
    if (q.length < 2) break;
    const ps = (await photon(q)).filter((p) => dongAt(data, p.lon, p.lat));
    if (ps.length) return { places: ps.slice(0, 5), used: q };
  }
  return { places: [], used: query };
}

export function dist(lon1: number, lat1: number, lon2: number, lat2: number): number {
  const R = 6371000, toR = Math.PI / 180;
  const dLat = (lat2 - lat1) * toR, dLon = (lon2 - lon1) * toR;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * toR) * Math.cos(lat2 * toR) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

function inRing(x: number, y: number, ring: number[][]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function inPolygon(x: number, y: number, poly: number[][][]): boolean {
  if (!inRing(x, y, poly[0])) return false;
  for (let k = 1; k < poly.length; k++) if (inRing(x, y, poly[k])) return false; // 구멍
  return true;
}

/** 좌표가 들어 있는 행정동 코드 (서울 밖이면 null) */
export function dongAt(data: Data, lon: number, lat: number): string | null {
  for (const f of data.geo.features) {
    const g: any = f.geometry;
    const polys: number[][][][] = g.type === "Polygon" ? [g.coordinates] : g.coordinates;
    if (polys.some((p) => inPolygon(lon, lat, p))) return (f.properties as any).code;
  }
  return null;
}

export interface Near { s: Sensor; d: number }

/** 쓸 수 있는(소음 값이 있는) 센서 중 가까운 순서 k개 */
export function nearestSensors(sensors: Sensor[], lon: number, lat: number, k = 3, maxM = 2000): Near[] {
  return sensors
    .filter((s) => s.noise_ok && s.l_night != null)
    .map((s) => ({ s, d: dist(lon, lat, s.lon, s.lat) }))
    .filter((x) => x.d <= maxM)
    .sort((a, b) => a.d - b.d)
    .slice(0, k);
}
