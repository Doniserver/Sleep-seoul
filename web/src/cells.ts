// 500m 육각형 칸별 0~23시 소음 (pipeline/cells.py 가 만든 years/{연도}_cells.json)
export interface Cell { id: string; lon: number; lat: number; n: number; ring: [number, number][]; h: number[] }
export interface CellsFile { year: number; hex_m: number; cuts: [number, number]; scores: [number, number, number]; n_sensors: number; cells: Cell[] }

const cache = new Map<number, Promise<CellsFile>>();
export function loadCells(year: number): Promise<CellsFile> {
  if (!cache.has(year)) {
    cache.set(year, fetch(`${import.meta.env.BASE_URL}data/years/${year}_cells.json`).then((r) => {
      if (!r.ok) throw new Error(`칸 자료: ${r.status}`);
      return r.json() as Promise<CellsFile>;
    }));
  }
  return cache.get(year)!;
}

/** 세 단계: 0 = 조용, 1 = 보통, 2 = 시끄러움 */
export type Grade = 0 | 1 | 2;
export const GRADES = [
  { word: "조용", tone: "quiet", color: "#3f93f2", feel: "교실 안보다 조용한 정도입니다." },
  { word: "보통", tone: "mid", color: "#aeb5c2", feel: "교실 안과 보통 대화 소리의 사이쯤입니다." },
  { word: "시끄러움", tone: "loud", color: "#f08122", feel: "보통 대화 소리가 계속 들리는 정도이거나 그보다 큽니다." },
] as const;

export function gradeOf(db: number, cuts: [number, number]): Grade {
  return db < cuts[0] ? 0 : db < cuts[1] ? 1 : 2;
}

/** 0~23시를 처음 보는 사람도 읽기 쉬운 말로 */
export function hourLabel(h: number): string {
  const part = h < 6 ? "새벽" : h < 12 ? "오전" : h < 18 ? "오후" : h < 22 ? "저녁" : "밤";
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${part} ${h12}시`;
}

// 좌표 → 칸 번호. pipeline/cells.py 의 to_xy·hex_of 와 같은 계산 (기준점과 지구 반지름도 같아야 한다)
const LON0 = 126.99, LAT0 = 37.55, R = 6371000;
export function cellIdAt(lon: number, lat: number, hexM: number): string {
  const rad = Math.PI / 180;
  const x = R * (lon - LON0) * rad * Math.cos(LAT0 * rad), y = R * (lat - LAT0) * rad;
  const s = hexM / Math.sqrt(3);
  const fq = ((Math.sqrt(3) / 3) * x - y / 3) / s, fr = ((2 / 3) * y) / s, fs = -fq - fr;
  let q = Math.round(fq), r = Math.round(fr);
  const sr = Math.round(fs);
  const dq = Math.abs(q - fq), dr = Math.abs(r - fr), ds = Math.abs(sr - fs);
  if (dq > dr && dq > ds) q = -r - sr;
  else if (dr > ds) r = -q - sr;
  return `${q}_${r}`;
}
