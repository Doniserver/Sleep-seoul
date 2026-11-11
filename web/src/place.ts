// 건물·장소 검색: 브이월드 검색 API(국토교통부) → 좌표 → 행정동 + 가까운 센서
import type { Data, Sensor } from "./data";

export interface Place { name: string; addr: string; lon: number; lat: number }

const VW_KEY = String(import.meta.env.VITE_VWORLD_KEY ?? "").trim();
const SEOUL_BBOX = [126.76, 37.41, 127.19, 37.72]; // minLon, minLat, maxLon, maxLat
const SEARCH = "https://api.vworld.kr/req/search";

/** 브이월드 검색은 브라우저 직접 호출(CORS)을 허용하지 않아 JSONP(callback)로 부른다 */
function jsonp<T>(url: string, timeoutMs = 8000): Promise<T> {
  return new Promise((resolve, reject) => {
    const cb = `__vw_cb_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
    const s = document.createElement("script");
    const done = () => { delete (window as any)[cb]; s.remove(); clearTimeout(t); };
    const t = setTimeout(() => { done(); reject(new Error("응답 시간 초과")); }, timeoutMs);
    (window as any)[cb] = (data: T) => { done(); resolve(data); };
    s.onerror = () => { done(); reject(new Error("연결 실패")); };
    s.src = `${url}&callback=${cb}`;
    document.head.appendChild(s);
  });
}

// 응답 필드(실제 응답으로 확인): response.status(OK/NOT_FOUND), result.items[].title, address.road/parcel, point.x/y
async function vworld(query: string, type: "place" | "address", category = ""): Promise<Place[]> {
  if (!VW_KEY) throw new Error("브이월드 인증키가 없습니다");
  const p = new URLSearchParams({ service: "search", request: "search", version: "2.0", crs: "EPSG:4326", size: "10", page: "1",
    type, format: "json", errorformat: "json", bbox: SEOUL_BBOX.join(","), query, key: VW_KEY });
  if (category) p.set("category", category);
  const j: any = await jsonp(`${SEARCH}?${p}`);
  const r = j?.response;
  if (!r || r.status === "NOT_FOUND") return [];
  if (r.status !== "OK") throw new Error(r.error?.text ?? `검색 오류 (${r.status})`);
  const out: Place[] = [];
  for (const it of r.result?.items ?? []) {
    const lon = parseFloat(it.point?.x), lat = parseFloat(it.point?.y);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    const addr = String(it.address?.road || it.address?.parcel || "").replace(/^서울특별시\s*/, "");
    const name = String(it.title || addr || query);
    if (out.some((o) => o.name === name && dist(o.lon, o.lat, lon, lat) < 50)) continue; // 같은 이름이 50m 안에 겹치면 하나만
    out.push({ name, addr, lon, lat });
  }
  return out;
}

/** 장소 이름으로 먼저 찾고, 없으면 도로명·지번 주소로 찾는다. 그래도 없으면 앞 단어를 하나씩 떼고 다시 찾는다. */
export async function searchPlaces(query: string, data: Data): Promise<{ places: Place[]; used: string }> {
  const words = query.trim().split(/\s+/);
  for (let i = 0; i < words.length; i++) {
    const q = words.slice(i).join(" ");
    if (q.length < 2) break;
    let ps = await vworld(q, "place");
    if (!ps.length) ps = await vworld(q, "address", "road");
    if (!ps.length) ps = await vworld(q, "address", "parcel");
    ps = ps.filter((p) => dongAt(data, p.lon, p.lat));
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
