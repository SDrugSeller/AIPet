// @ts-check
// main(엔진)과 renderer(그리기)가 같은 공식으로 펫 위치를 계산하기 위한 공용 모듈.
// 걷기/낙하 중에는 위치를 매 프레임 IPC로 보내지 않고, 시작 상태(t0, move)만 보낸다.

/** 낙하 가속도 (DIP/s²) */
export const FALL_GRAVITY = 3000;

/**
 * @typedef {{ kind: 'walk', x1: number, speed: number }
 *   | { kind: 'fall', y1: number, g: number }
 *   | { kind: 'jump', x1: number, y1: number, dur: number, height: number }} Move
 * walk: pet.x에서 x1까지 speed(DIP/s)로 등속 이동 / fall: pet.y에서 y1까지 가속 낙하 /
 * jump: (pet.x, pet.y)에서 (x1, y1)까지 dur(ms) 동안 포물선으로 뛰어오른다 (height만큼 위로 솟는다)
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
  if (m.kind === 'jump') {
    const k = Math.min(1, (Math.max(0, now - pet.t0)) / m.dur);
    return {
      x: pet.x + (m.x1 - pet.x) * k,
      y: pet.y + (m.y1 - pet.y) * k - 4 * m.height * k * (1 - k),
    };
  }
  return { x: pet.x, y: Math.min(m.y1, pet.y + 0.5 * m.g * t * t) };
}

// --- 모니터 사이 이동: 문으로 들어가서 다른 모니터의 문에서 나온다 (엔진과 렌더러가 같은 시간표를 쓴다) ---

/** 문이 열리는 시간, 닫히는 시간(ms) */
export const DOOR_OPEN_MS = 300;
export const DOOR_CLOSE_MS = 300;

/**
 * @typedef {{ x: number, y: number, w: number, h: number, t0: number, dur: number }} Door
 *   x, y: 문 바닥 가운데(가상 데스크톱 DIP), w/h: 문 크기, t0: 문이 열리기 시작한 시각, dur: 닫히기까지 포함한 전체 시간
 * @typedef {{ t0: number, dur: number, from: number, to: number }} Fade
 *   펫의 투명도가 dur(ms) 동안 from에서 to로 바뀐다 (0=안 보임, 1=보임). 끝난 뒤에는 to로 머문다.
 */

/** 문이 열린 정도 0~1 (열리는 중 → 1 → 닫히는 중 → 0). 아직 안 열렸거나 이미 닫혔으면 0 @param {Door} door @param {number} now */
export function doorOpenness(door, now) {
  const e = now - door.t0;
  if (e <= 0 || e >= door.dur) return 0;
  return Math.min(1, e / DOOR_OPEN_MS) * Math.min(1, (door.dur - e) / DOOR_CLOSE_MS);
}

/**
 * 문 스프라이트의 지금 프레임 번호. 아직 안 열렸거나 이미 닫혔으면 null.
 * 시트는 `openFrames`장의 "열리는" 그림(닫힘 → 활짝)과, 있으면 그 뒤 나머지 "닫히는" 그림으로 이루어진다.
 * 닫히는 그림이 없으면(openFrames가 frames와 같으면) 열리는 그림을 거꾸로 재생한다. 열려 있는 동안은 활짝 열린 마지막 열림 프레임.
 * 프레임이 나오는 시간은 프레임 수와 상관없이 DOOR_OPEN_MS, DOOR_CLOSE_MS에 맞춰 늘어난다.
 * @param {Door} door @param {number} now @param {{ frames: number, openFrames?: number }} spec
 * @returns {number | null}
 */
export function doorFrameAt(door, now, spec) {
  const e = now - door.t0;
  if (e <= 0 || e >= door.dur) return null;
  const open = Math.max(1, Math.min(spec.openFrames ?? spec.frames, spec.frames));
  if (e < DOOR_OPEN_MS) return Math.min(open - 1, Math.floor((e / DOOR_OPEN_MS) * open));
  const closing = e - (door.dur - DOOR_CLOSE_MS);
  if (closing < 0) return open - 1;
  const k = closing / DOOR_CLOSE_MS;
  const closeN = spec.frames - open;
  if (closeN > 0) return open + Math.min(closeN - 1, Math.floor(k * closeN));
  return open - 1 - Math.min(open - 1, Math.floor(k * open));
}

/** 펫의 투명도 0~1. fade가 없으면 1(보임) @param {{ fade?: Fade | null }} pet @param {number} now */
export function alphaAt(pet, now) {
  const f = pet.fade;
  if (!f) return 1;
  const k = f.dur <= 0 ? 1 : Math.min(1, Math.max(0, (now - f.t0) / f.dur));
  return f.from + (f.to - f.from) * k;
}

/** 이동이 끝나기까지 걸리는 시간(ms) @param {PetMotionState} pet */
export function moveDuration(pet) {
  const m = pet.move;
  if (!m) return 0;
  if (m.kind === 'walk') return (Math.abs(m.x1 - pet.x) / m.speed) * 1000;
  if (m.kind === 'jump') return m.dur;
  return Math.sqrt((2 * Math.max(0, m.y1 - pet.y)) / m.g) * 1000;
}
