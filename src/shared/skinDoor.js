// @ts-check
// 스킨의 문(모니터 사이를 오갈 때 나오는 문) 스프라이트 정의. main(스킨 로딩, 검사)과 테스트가 함께 쓴다.
//
// skin.json의 "door": 문이 열리고 닫히는 가로 1줄 시트. 펫과 별개로 화면에 겹쳐 그려지지만 그림은 스킨 폴더에서 같이 관리한다.
//   { "sheet": "door.png", "frames": 10, "openFrames": 6, "frameSize": {"w":128,"h":128}, "anchor": {"x":64,"y":124}, "scale": 1 }
//   - openFrames장: 닫힘 → 활짝 (생략하면 frames 전부. 그러면 닫힐 때 거꾸로 재생)
//   - 나머지(frames - openFrames)장: 활짝 → 닫힘
//   - anchor: 문 바닥 가운데(문이 서 있는 자리), 프레임 좌상단 기준 픽셀. scale: 화면 배율
// door가 없는 스킨은 기본 스킨(default)의 문을 쓴다. 그것도 없으면 코드로 그린 문을 쓴다.

const SHEET_PATH = /^[A-Za-z0-9_./-]+\.png$/;

/** @param {unknown} v @param {number} min @param {number} max */
const isNum = (v, min, max) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;

/**
 * 사용자 스킨의 door 값을 검사한다. 문제가 있으면 사유를, 괜찮으면(또는 없으면) null을 반환한다.
 * @param {any} door
 * @returns {string | null}
 */
export function validateDoor(door) {
  if (door === undefined) return null;
  if (!door || typeof door !== 'object' || Array.isArray(door)) return 'door가 객체가 아니에요';
  if (typeof door.sheet !== 'string' || !SHEET_PATH.test(door.sheet) || door.sheet.includes('..') || door.sheet.startsWith('/')) {
    return 'door.sheet는 스킨 폴더 안의 .png 상대 경로여야 해요';
  }
  if (!Number.isInteger(door.frames) || door.frames < 1 || door.frames > 64) return 'door.frames는 1~64 정수여야 해요';
  if (door.openFrames !== undefined && (!Number.isInteger(door.openFrames) || door.openFrames < 1 || door.openFrames > door.frames)) {
    return 'door.openFrames는 1 이상 frames 이하 정수여야 해요';
  }
  const fs_ = door.frameSize;
  if (!fs_ || !isNum(fs_.w, 8, 2048) || !isNum(fs_.h, 8, 2048)) return 'door.frameSize.w/h는 8~2048 사이 숫자여야 해요';
  if (!door.anchor || !isNum(door.anchor.x, -4096, 4096) || !isNum(door.anchor.y, -4096, 4096)) return 'door.anchor.x/y가 숫자여야 해요';
  if (door.scale !== undefined && !isNum(door.scale, 0.01, 16)) return 'door.scale은 0.01~16 사이여야 해요';
  return null;
}

/** @param {number} n */
const round2 = (n) => Math.round(n * 100) / 100;

/**
 * skin.json의 door를 렌더러가 쓸 형태로 바꾼다.
 * @param {{ door: any, owner: string, factor: number, pixelArt: boolean }} p
 *   owner: 시트가 들어 있는 스킨 폴더 이름(다른 스킨의 문을 빌려 쓰면 그 스킨),
 *   factor: 문을 펫 크기에 맞추는 배율 (펫이 화면에서 차지하는 높이 ÷ 이 문이 만들어질 때의 펫 높이)
 * @returns {{ skin: string, sheet: string, frames: number, openFrames: number, frameSize: { w: number, h: number },
 *   anchor: { x: number, y: number }, scale: number, pixelArt: boolean, display: { w: number, h: number } }}
 */
export function resolveDoor({ door, owner, factor, pixelArt }) {
  const scale = Math.round((door.scale ?? 1) * factor * 10000) / 10000;
  return {
    skin: owner,
    sheet: door.sheet,
    frames: door.frames,
    openFrames: door.openFrames ?? door.frames,
    frameSize: { w: door.frameSize.w, h: door.frameSize.h },
    anchor: { x: door.anchor.x, y: door.anchor.y },
    scale,
    pixelArt,
    /** 화면에 그려지는 크기(px) */
    display: { w: round2(door.frameSize.w * scale), h: round2(door.frameSize.h * scale) },
  };
}
