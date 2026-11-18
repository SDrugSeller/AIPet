// @ts-check
// 스킨의 문(모니터 사이를 오갈 때 나오는 문) 스프라이트 정의. main(스킨 로딩, 검사)과 테스트가 함께 쓴다.
//
// skin.json의 "door": 문이 열리고 닫히는 가로 1줄 시트. 펫과 별개로 화면에 겹쳐 그려지지만 그림은 스킨 폴더에서 같이 관리한다.
//   { "sheet": "door.png", "frames": 10, "openFrames": 6, "frameSize": {"w":128,"h":128}, "anchor": {"x":64,"y":124}, "scale": 1 }
//   - opening(선택): 방향이 있는 그림(토관처럼 입구가 한쪽을 보는 것)에서 시트 속 입구가 향한 쪽("left" | "right").
//     주면 입구가 다가오는 펫 쪽을 보도록 필요할 때 좌우로 뒤집어 그린다. 생략하면 뒤집지 않는다.
//   - front(선택): 펫보다 앞에 그려지는 시트(sheet와 같은 frames/frameSize). 토관처럼 몸통이 펫을 가려야 하는 옆모습 문에 쓴다.
//     sheet는 펫 뒤, front는 펫 앞에 그려서 펫이 문 안으로 걸어 들어가고 걸어 나온다. 생략하면 문 전체가 펫 뒤에 있고 펫은 문 앞에서 흐려진다.
//   - enter(선택): front가 있을 때, 펫이 가려질 때까지 문 기준점(anchor)에서 안쪽으로 더 걸어가는 거리(프레임 픽셀)
//   - openFrames장: 닫힘 → 활짝 (생략하면 frames 전부. 그러면 닫힐 때 거꾸로 재생)
//   - 나머지(frames - openFrames)장: 활짝 → 닫힘
//   - anchor: 문 바닥 가운데(문이 서 있는 자리), 프레임 좌상단 기준 픽셀. scale: 화면 배율
// door가 없는 스킨은 기본 스킨(default)의 문을 쓴다. 그것도 없으면 코드로 그린 문을 쓴다.

const SHEET_PATH = /^[A-Za-z0-9_./-]+\.png$/;

/** 문 크기 조절(설정 → 펫 → 스킨 크기): 기본 크기에 대한 퍼센트. 슬라이더는 SLIDER_MAX까지, 직접 입력은 MAX까지 */
export const DOOR_PERCENT_MIN = 25;
export const DOOR_PERCENT_MAX = 400;
export const DOOR_PERCENT_SLIDER_MAX = 300;
export const DOOR_PERCENT_DEFAULT = 100;

/**
 * 문 그림의 배율 보정: 문이 만들어질 때의 펫 높이 대비 지금 펫 높이의 비율에, 사용자가 정한 문 크기(%)를 곱한다.
 * 펫 크기를 바꾸면 문도 같은 비율로 따라가고, 문 크기(%)로 문만 따로 키우고 줄일 수 있다.
 * @param {{ petDisplayH: number, ownerPetDisplayH: number, percent?: number }} p
 *   petDisplayH: 지금 펫이 화면에서 차지하는 높이(px), ownerPetDisplayH: 문 그림을 만든 스킨의 펫 높이(px), percent: 문 크기(%)
 */
export function doorFactor({ petDisplayH, ownerPetDisplayH, percent }) {
  return (petDisplayH / ownerPetDisplayH) * ((percent ?? DOOR_PERCENT_DEFAULT) / 100);
}

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
  if (door.opening !== undefined && door.opening !== 'left' && door.opening !== 'right') return 'door.opening은 "left" 또는 "right"여야 해요';
  if (door.front !== undefined && (typeof door.front !== 'string' || !SHEET_PATH.test(door.front) || door.front.includes('..') || door.front.startsWith('/'))) {
    return 'door.front는 스킨 폴더 안의 .png 상대 경로여야 해요';
  }
  if (door.enter !== undefined && !isNum(door.enter, 0, 2048)) return 'door.enter는 0~2048 사이 숫자여야 해요';
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
 *   anchor: { x: number, y: number }, scale: number, pixelArt: boolean, display: { w: number, h: number },
 *   opening: 'left' | 'right' | null, front: string | null, enter: number }}
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
    /** 시트 속 입구가 향한 쪽 (방향이 없는 문이면 null) */
    opening: door.opening ?? null,
    /** 펫보다 앞에 그려지는 시트 파일 (없으면 null: 문 전체가 펫 뒤에 그려진다) */
    front: door.front ?? null,
    /** 앞 레이어 뒤로 걸어 들어갈 때, 문 기준점에서 안쪽으로 더 걸어가는 거리(화면 px) */
    enter: round2((door.enter ?? 0) * scale),
    /** 화면에 그려지는 크기(px) */
    display: { w: round2(door.frameSize.w * scale), h: round2(door.frameSize.h * scale) },
  };
}
