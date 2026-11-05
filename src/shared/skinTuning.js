// @ts-check
// 스킨 크기 조정: 사용자가 입력한 "프레임 크기(px)"와 "화면에 표시할 높이(px)"에 맞춰
// 크기(scale), 앵커(발 위치), 히트박스를 자동으로 환산한다.
// main(스킨 로딩)과 설정 창(미리보기)이 같은 공식을 쓰도록 공용 모듈로 둔다.
//
// 기준은 skin.json에 적힌 값("원본"): frameSize, scale, anchor, hitbox는 원본 프레임 크기 기준 픽셀이다.
// 사용자가 시트를 다른 해상도로 바꿨다면 실제 프레임 크기를 입력하고, 앵커/히트박스는 그 비율만큼 늘고 줄어든다.

/**
 * @typedef {{ frameSize: { w: number, h: number }, scale: number,
 *   anchor: { x: number, y: number }, hitbox?: { x: number, y: number, w: number, h: number } }} AuthoredSkin
 * @typedef {{ frameW?: number, frameH?: number, displayH?: number }} Tuning
 *   frameW/frameH: 시트에서 한 프레임의 실제 크기(px), displayH: 화면에 표시할 프레임 높이(px)
 */

/** @param {number} n */
const round2 = (n) => Math.round(n * 100) / 100;

/**
 * 원본 값과 사용자 조정값으로 실제 쓸 크기/앵커/히트박스를 구한다.
 *  - 조정값을 비우면 원본 그대로
 *  - displayH를 비우면 "원본이 화면에서 차지하던 높이"를 유지한다 (해상도만 바꿔도 펫 크기는 그대로)
 * @param {AuthoredSkin} authored @param {Tuning | null | undefined} [t]
 */
export function applyTuning(authored, t) {
  const aw = authored.frameSize.w;
  const ah = authored.frameSize.h;
  const fw = t?.frameW ?? aw;
  const fh = t?.frameH ?? ah;
  const rx = fw / aw;
  const ry = fh / ah;
  const hb = authored.hitbox ?? { x: 0, y: 0, w: aw, h: ah };
  const displayH = t?.displayH ?? ah * authored.scale;
  const scale = displayH / fh;
  return {
    frameSize: { w: fw, h: fh },
    scale: Math.round(scale * 10000) / 10000,
    anchor: { x: round2(authored.anchor.x * rx), y: round2(authored.anchor.y * ry) },
    hitbox: { x: round2(hb.x * rx), y: round2(hb.y * ry), w: round2(hb.w * rx), h: round2(hb.h * ry) },
    /** 화면에 그려지는 프레임 크기(px) */
    displaySize: { w: round2(fw * scale), h: round2(fh * scale) },
  };
}

/**
 * 시트 이미지 크기가 프레임 크기 × 프레임 수와 맞는지 확인한다. 안 맞으면 프레임이 엉뚱하게 잘린다.
 * @param {{ w: number, h: number }} frameSize
 * @param {{ anim: string, frames: number, width: number, height: number }[]} sheets
 * @returns {string[]} 사람이 읽을 수 있는 문제 목록 (없으면 빈 배열)
 */
export function checkSheets(frameSize, sheets) {
  const problems = [];
  for (const s of sheets) {
    const expectW = frameSize.w * s.frames;
    if (s.width !== expectW) problems.push(`${s.anim}: 너비 ${s.width}px (프레임 ${frameSize.w}px × ${s.frames}장 = ${expectW}px여야 해요)`);
    if (s.height !== frameSize.h) problems.push(`${s.anim}: 높이 ${s.height}px (${frameSize.h}px여야 해요)`);
  }
  return problems;
}

/**
 * 시트 한 장의 크기에서 프레임 크기를 추정한다 (너비 ÷ 프레임 수, 높이는 그대로).
 * 너비가 프레임 수로 나누어떨어지지 않으면 null.
 * @param {{ frames: number, width: number, height: number }} sheet
 */
export function detectFrameSize(sheet) {
  if (!sheet.frames || sheet.width % sheet.frames !== 0) return null;
  return { w: sheet.width / sheet.frames, h: sheet.height };
}
