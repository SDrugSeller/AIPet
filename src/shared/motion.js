// @ts-check
// main(엔진)과 renderer(그리기)가 같은 공식으로 펫 위치를 계산하기 위한 공용 모듈.
// 걷기/낙하 중에는 위치를 매 프레임 IPC로 보내지 않고, 시작 상태(t0, move)만 보낸다.

/** 낙하 가속도 (DIP/s²) */
export const FALL_GRAVITY = 3000;

/**
 * @typedef {{ kind: 'walk', x1: number, speed: number }
 *   | { kind: 'fall', y1: number, g: number }} Move
 * walk: pet.x에서 x1까지 speed(DIP/s)로 등속 이동 / fall: pet.y에서 y1까지 가속 낙하
 */

/**
 * @typedef {Object} PetMotionState
 * @property {number} x  이동 시작 시점의 위치(발 기준, 가상 데스크톱 DIP)
 * @property {number} y
 * @property {Move | null} move
 * @property {number} t0  이동 시작 시각 (Date.now())
 */

/** @param {PetMotionState} pet @param {number} now */
export function positionAt(pet, now) {
  const m = pet.move;
  if (!m) return { x: pet.x, y: pet.y };
  const t = Math.max(0, now - pet.t0) / 1000;
  if (m.kind === 'walk') {
    const dist = Math.min(Math.abs(m.x1 - pet.x), m.speed * t);
    return { x: pet.x + Math.sign(m.x1 - pet.x) * dist, y: pet.y };
  }
  return { x: pet.x, y: Math.min(m.y1, pet.y + 0.5 * m.g * t * t) };
}

/** 이동이 끝나기까지 걸리는 시간(ms) @param {PetMotionState} pet */
export function moveDuration(pet) {
  const m = pet.move;
  if (!m) return 0;
  if (m.kind === 'walk') return (Math.abs(m.x1 - pet.x) / m.speed) * 1000;
  return Math.sqrt((2 * Math.max(0, m.y1 - pet.y)) / m.g) * 1000;
}
