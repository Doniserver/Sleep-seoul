// 발산형 색: 서울 중간(52~54dB)을 어두운 중립 회색으로 두고, 조용한 쪽은 파랑·시끄러운 쪽은 주황으로 갈수록 밝아진다.
// 파랑↔주황은 색각 이상에서도 구분되고, 시끄러운 끝(노랑)이 조용한 끝보다 더 밝아 명도로도 순서가 읽힌다.
// 기종 보정 뒤 동 값이 48~58dB에 몰려 있어 2dB 간격으로 나눈다
export const BREAKS = [48, 50, 52, 54, 56, 58];
export const COLORS = ["#7cc4ff", "#3a8eea", "#27559b", "#5a606b", "#96501f", "#ea7d22", "#ffc650"];
export const NODATA = "#161c29";   // 차트의 빈 칸. 지도에서는 색을 칠하지 않는다(배경지도가 그대로 보임)

export function colorFor(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return NODATA;
  let i = 0;
  while (i < BREAKS.length && v >= BREAKS[i]) i++;
  return COLORS[i];
}

/** 배경색 위 글자색 (대비 4.5:1 이상 되도록 밝은 칸엔 검정) */
export function inkFor(bg: string): string {
  const n = parseInt(bg.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  });
  const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  return L > 0.25 ? "#111" : "#fff";
}

export const step = (input: unknown) => ["step", input, COLORS[0], ...BREAKS.flatMap((b, i) => [b, COLORS[i + 1]])];
