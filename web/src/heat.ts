// 소음 히트맵 자료 (pipeline/heatmap.py 가 만든 data/heat/)
export interface HeatInfo {
  year: number; width: number; height: number; cell_m: number; sigma_m: number; n_sensors: number;
  bounds: { west: number; south: number; east: number; north: number };
  colors: string[]; scores: number[];
  frames: Record<string, { file: string; cuts: number[]; share: number[]; mae: number }>;
}
/** 동네별: 그림 이름 → 동네 코드 → [조용, 보통, 시끄러움 자리의 비율, 평균 dB] */
export type DongShares = Record<string, Record<string, [number, number, number, number]>>;

const base = () => `${import.meta.env.BASE_URL}data/heat/`;
const j = <T>(name: string) => fetch(base() + name).then((r) => { if (!r.ok) throw new Error(`${name}: ${r.status}`); return r.json() as Promise<T>; });
export const loadHeat = () => j<HeatInfo>("heat.json");
export const loadDongShares = () => j<DongShares>("dongs.json");
export const heatUrl = (info: HeatInfo, key: string) => base() + info.frames[key].file;

export const WORDS = ["조용", "보통", "시끄러움"];
export const FEEL = [
  "밤에 창문을 열어도 크게 거슬리지 않을 정도입니다.",
  "차 소리나 생활 소음이 어느 정도 들립니다.",
  "큰길이나 번화가 가까이라 소리가 이어집니다.",
];

/** 자리마다 단계(0~2, 값 없음 255)를 꺼낸다. 단계 그림의 빨강 값 = (단계+1)×80 */
export async function loadLevels(info: HeatInfo, key: string): Promise<Uint8Array> {
  const im = new Image();
  await new Promise<void>((res, rej) => { im.onload = () => res(); im.onerror = () => rej(new Error("단계 그림")); im.src = `${base()}heatlv_${key}.png`; });
  const cv = document.createElement("canvas"); cv.width = info.width; cv.height = info.height;
  const cx = cv.getContext("2d", { willReadFrequently: true })!; cx.drawImage(im, 0, 0);
  const d = cx.getImageData(0, 0, info.width, info.height).data;
  const out = new Uint8Array(info.width * info.height);
  for (let i = 0; i < out.length; i++) { const k = Math.round(d[i * 4] / 80); out[i] = k === 0 ? 255 : k - 1; }
  return out;
}

/** 경위도 → 그림의 칸 번호 (그림은 웹 지도와 같은 투영). 범위 밖이면 null */
export function pixelIndex(info: HeatInfo, lon: number, lat: number): number | null {
  const my = (la: number) => Math.log(Math.tan(Math.PI / 4 + (la * Math.PI) / 360));
  const b = info.bounds;
  const x = Math.floor(((lon - b.west) / (b.east - b.west)) * info.width);
  const y = Math.floor(((my(b.north) - my(lat)) / (my(b.north) - my(b.south))) * info.height);
  return x < 0 || y < 0 || x >= info.width || y >= info.height ? null : y * info.width + x;
}

/** 0~23시를 처음 보는 사람도 읽기 쉬운 말로 */
export function hourLabel(h: number): string {
  const part = h < 6 ? "새벽" : h < 12 ? "오전" : h < 18 ? "오후" : h < 22 ? "저녁" : "밤";
  return `${part} ${h % 12 === 0 ? 12 : h % 12}시`;
}

// ── 동네별 보기: 동네의 단계 = 그 동네의 평균 dB를 지도와 같은 기준으로 나눈 것 (0 조용, 1 보통, 2 시끄러움) ──
export function dongGrade(meanDb: number, cuts: number[]): number {
  return meanDb < cuts[0] ? 0 : meanDb < cuts[1] ? 1 : 2;
}
/** 동네별 지도의 색. 히트맵과 달리 조용한 동네도 옅게 칠한다(칠하지 않으면 지도가 비어 보인다) */
export const DONG_COLORS = ["#fdf0d5", "#f7b25c", "#d63e30"];
