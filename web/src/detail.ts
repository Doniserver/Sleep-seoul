// 상세 추정 지도: 10m 칸마다 주변 조건(도로·철도·상가)으로 추정한 밤 소음. 측정값이 아니라 추정값.
// 파일 하나(회색조 PNG, 값 1 = 30dB, 1마다 0.25dB, 0 = 값 없음)를 받아 브라우저에서 색을 입힌다.

export interface NoiseMapMeta {
  year: number; file: string; width: number; height: number; cell_m: number;
  bounds: { west: number; south: number; east: number; north: number };
  encoding: { min_db: number; step_db: number; nodata: number };
  accuracy: { n: number; mae: number; within3: number; within5: number; baseline_mae: number };
  quantiles: Record<string, number>;
  flags?: { file: string; items: { bit: number; name: string; label: string }[] };
  day?: { file: string; hours: [number, number]; accuracy: { mae: number; within3: number; within5: number } } | null;  // 낮(06~22시) 지도
}

/** 단면: 근처에서 가장 시끄러운 쪽(큰길)에서 이 자리를 지나 안쪽으로 이어지는 선 위의 추정값 */
export interface Profile { pts: { m: number; db: number }[]; hereM: number; hereDb: number; peakDb: number }

export interface NoiseMap {
  meta: NoiseMapMeta;
  canvas: HTMLCanvasElement;                       // 색을 입힌 그림 (지도에 올림)
  coords: [[number, number], [number, number], [number, number], [number, number]];
  valueAt(lon: number, lat: number): number | null; // 그 자리의 추정 dB
  profile(lon: number, lat: number): Profile | null;
  flagsAt(lon: number, lat: number): Promise<string[]>; // 그 자리의 주의 표시 문구
  hasDay: boolean;                                 // 낮 지도도 있는가
  /** 밤 지도 또는 낮 지도로 바꿔 그린다. 그릴 수 없으면 false */
  setMode(mode: "night" | "day"): Promise<boolean>;
  shift(): number;                                 // 지금 색 기준이 밤 기준보다 몇 dB 위로 옮겨졌는가
}

// 발산형 색: 서울 중간(밤 약 53.5dB)을 어두운 중립 회색으로 두고, 조용한 쪽은 파랑·시끄러운 쪽은 주황으로 갈수록 밝아진다.
// 어두운 회색조 배경지도 위에서 양쪽 끝이 모두 또렷하고, 파랑↔주황은 색각 이상에서도 구분된다. 시끄러운 끝(노랑)이 조용한 끝보다 더 밝다.
export const DETAIL_MID = 52.5, DETAIL_SPAN = 5;      // 색 기준: 가운데 ± 5dB
export const DETAIL_STOPS: [number, string][] = [
  [47.5, "#9ad6ff"], [49, "#4a9bf0"], [50.25, "#2c6bc7"], [51.5, "#27477f"], [52.5, "#3d424b"], [53.5, "#96501f"], [55, "#ea7d22"], [56.5, "#ffb53d"], [57.5, "#ffe493"],
];

const hex = (h: string) => [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];

// 낮은 서울 전체가 밤보다 몇 dB 높다. 색이 한쪽 끝에 몰리지 않도록 색 기준 전체를 그만큼(정수 dB) 옮긴다. 범례 숫자도 함께 바뀐다.
let colorShift = 0;

/** dB → 색 (정지점 사이는 이어서 섞음) */
export function detailColor(db: number): [number, number, number] {
  const s = DETAIL_STOPS;
  db -= colorShift;
  if (db <= s[0][0]) return hex(s[0][1]) as [number, number, number];
  for (let i = 1; i < s.length; i++) {
    if (db <= s[i][0]) {
      const t = (db - s[i - 1][0]) / (s[i][0] - s[i - 1][0]);
      const a = hex(s[i - 1][1]), b = hex(s[i][1]);
      return [0, 1, 2].map((k) => Math.round(a[k] + (b[k] - a[k]) * t)) as [number, number, number];
    }
  }
  return hex(s[s.length - 1][1]) as [number, number, number];
}

export const detailCss = (db: number) => { const [r, g, b] = detailColor(db); return `rgb(${r},${g},${b})`; };

const mercY = (lat: number) => Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360));

let cache: Promise<NoiseMap | null> | null = null;

export function loadNoiseMap(): Promise<NoiseMap | null> {
  cache ??= (async () => {
    try {
      const meta: NoiseMapMeta = await (await fetch("data/noisemap/noisemap.json")).json();
      const img = new Image();
      img.src = `data/noisemap/${meta.file}`;
      await img.decode();
      const canvas = document.createElement("canvas");
      canvas.width = meta.width; canvas.height = meta.height;
      const ctx = canvas.getContext("2d", { willReadFrequently: false })!;
      ctx.drawImage(img, 0, 0);
      const im = ctx.getImageData(0, 0, meta.width, meta.height);
      const px = im.data, n = meta.width * meta.height;
      const night = new Uint8Array(n);
      for (let i = 0; i < n; i++) night[i] = px[i * 4];
      let vals: Uint8Array = night;                               // 지금 화면에 쓰는 값 (밤 또는 고른 시간대)
      const median = (a: Uint8Array) => {
        const hist = new Uint32Array(256); let cnt = 0;
        for (let i = 0; i < n; i++) if (a[i]) { hist[a[i]]++; cnt++; }
        let acc = 0;
        for (let v = 1; v < 256; v++) { acc += hist[v]; if (acc >= cnt / 2) return meta.encoding.min_db + (v - 1) * meta.encoding.step_db; }
        return 0;
      };
      const nightMedian = median(night);
      // 값(0~255)마다 색을 미리 정해 두고 칸마다 찾아 쓴다
      const paint = () => {
        // 가운데(중간)일수록 비쳐서 배경지도가 보이고, 조용한 쪽·시끄러운 쪽 끝으로 갈수록 진해진다
        const lut = new Uint8Array(256 * 3), alpha = new Uint8Array(256);
        for (let v = 1; v < 256; v++) {
          const db = meta.encoding.min_db + (v - 1) * meta.encoding.step_db;
          lut.set(detailColor(db), v * 3);
          alpha[v] = Math.round(255 * (0.5 + 0.45 * Math.min(1, Math.abs(db - colorShift - DETAIL_MID) / DETAIL_SPAN)));
        }
        for (let i = 0; i < n; i++) {
          const v = vals[i];
          if (v === 0) { px[i * 4 + 3] = 0; continue; }
          px[i * 4] = lut[v * 3]; px[i * 4 + 1] = lut[v * 3 + 1]; px[i * 4 + 2] = lut[v * 3 + 2]; px[i * 4 + 3] = alpha[v];
        }
        ctx.putImageData(im, 0, 0);
      };
      paint();
      // 낮 지도 (처음 쓸 때 한 번만 받는다)
      let dayVals: Promise<Uint8Array | null> | null = null;
      const loadDay = () => (dayVals ??= (async () => {
        if (!meta.day) return null;
        try {
          const g = new Image(); g.src = `data/noisemap/${meta.day.file}`; await g.decode();
          const cv = document.createElement("canvas"); cv.width = meta.width; cv.height = meta.height;
          const cx = cv.getContext("2d")!; cx.drawImage(g, 0, 0);
          const d = cx.getImageData(0, 0, meta.width, meta.height).data, out = new Uint8Array(n);
          for (let i = 0; i < n; i++) out[i] = d[i * 4];
          return out;
        } catch { return null; }
      })());
      let token = 0;
      const setMode = async (mode: "night" | "day"): Promise<boolean> => {
        const my = ++token;
        if (mode === "night") { vals = night; colorShift = 0; paint(); return true; }
        const d = await loadDay();
        if (!d) return false;
        if (my !== token) return true;                // 그 사이 다시 바꿨으면 그쪽에 맡긴다
        vals = d;
        colorShift = Math.round(median(d) - nightMedian);
        paint();
        return true;
      };
      const b = meta.bounds, yN = mercY(b.north), yS = mercY(b.south);
      const cellOf = (lon: number, lat: number) => {
        const c = Math.floor(((lon - b.west) / (b.east - b.west)) * meta.width);
        const r = Math.floor(((yN - mercY(lat)) / (yN - yS)) * meta.height);
        return c < 0 || r < 0 || c >= meta.width || r >= meta.height ? -1 : r * meta.width + c;
      };
      const valueAt = (lon: number, lat: number) => {
        const i = cellOf(lon, lat);
        return i < 0 || vals[i] === 0 ? null : meta.encoding.min_db + (vals[i] - 1) * meta.encoding.step_db;
      };
      // 방향(도)과 거리(m)만큼 옮긴 좌표
      const move = (lon: number, lat: number, deg: number, m: number): [number, number] => {
        const a = (deg * Math.PI) / 180;
        return [lon + (Math.sin(a) * m) / (111320 * Math.cos((lat * Math.PI) / 180)), lat + (Math.cos(a) * m) / 110950];
      };
      let flagVals: Promise<Uint8Array | null> | null = null;
      const loadFlags = () => (flagVals ??= (async () => {
        if (!meta.flags) return null;
        try {
          const im2 = new Image(); im2.src = `data/noisemap/${meta.flags.file}`; await im2.decode();
          const cv = document.createElement("canvas"); cv.width = meta.width; cv.height = meta.height;
          const cx = cv.getContext("2d")!; cx.drawImage(im2, 0, 0);
          const d = cx.getImageData(0, 0, meta.width, meta.height).data, out = new Uint8Array(n);
          for (let i = 0; i < n; i++) out[i] = d[i * 4];
          return out;
        } catch { return null; }
      })());
      return {
        meta, canvas,
        profile(lon, lat) {
          const here = valueAt(lon, lat);
          if (here === null) return null;
          // 16방향으로 250m까지 훑어 가장 시끄러운 지점(대개 큰길)을 찾는다
          let best = { deg: 0, m: 0, db: here };
          for (let deg = 0; deg < 360; deg += 22.5) for (let m = 10; m <= 250; m += 10) {
            const v = valueAt(...move(lon, lat, deg, m));
            if (v !== null && v > best.db + 0.01) best = { deg, m, db: v };
          }
          // 그 지점에서 이 자리를 지나 150m 더 안쪽까지
          const pts: { m: number; db: number }[] = [];
          for (let m = -best.m; m <= 150; m += 10) {
            const v = valueAt(...move(lon, lat, best.deg + 180, m));
            if (v !== null) pts.push({ m: m + best.m, db: v });
          }
          return pts.length < 3 ? null : { pts, hereM: best.m, hereDb: here, peakDb: best.db };
        },
        async flagsAt(lon, lat) {
          const f = await loadFlags(), i = cellOf(lon, lat);
          if (!f || i < 0 || !meta.flags) return [];
          return meta.flags.items.filter((it) => (f[i] >> it.bit) & 1).map((it) => it.label);
        },
        coords: [[b.west, b.north], [b.east, b.north], [b.east, b.south], [b.west, b.south]],
        valueAt, setMode, hasDay: !!meta.day, shift: () => colorShift,
      };
    } catch {
      return null;   // 파일이 없으면 상세 지도 없이 동작
    }
  })();
  return cache;
}
