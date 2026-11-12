// 조용함 = 파랑(어두움) → 시끄러움 = 주황(밝음). 명도가 단계마다 올라가서 색약·흑백에서도 순서가 읽힘.
// 기종 보정 뒤 동 값이 48~58dB에 몰려 있어 2dB 간격으로 나눈다
export const BREAKS = [48, 50, 52, 54, 56, 58];
export const COLORS = ["#23406b", "#2f5d96", "#5b86b8", "#a9b9c9", "#e0a458", "#f5b041", "#ffe08a"];
export const NODATA = "#3a3f4b";
export const LABELS = ["48 미만", "48–50", "50–52", "52–54", "54–56", "56–58", "58 이상"];

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
