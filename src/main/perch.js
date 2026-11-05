// @ts-check
// 펫이 올라설 수 있는 창(perch)을 판정하는 순수 로직. Electron에 의존하지 않아 테스트할 수 있다.

/**
 * 스킨에서 "몸" 크기를 구한다 (히트박스 기준, 발 위치에서 좌/우/위로 얼마나 나가는가).
 * 투명한 여백이 아니라 실제 몸이 창 가장자리 안에 들어오게 하는 데 쓴다.
 * @param {{ anchor: {x:number,y:number}, scale?: number, hitbox?: {x:number,y:number,w:number,h:number}, frameSize: {w:number,h:number} }} skin
 */
export function bodyMetrics(skin) {
  const s = skin.scale ?? 1;
  const hb = skin.hitbox ?? { x: 0, y: 0, w: skin.frameSize.w, h: skin.frameSize.h };
  return {
    bodyLeft: (skin.anchor.x - hb.x) * s,
    bodyRight: (hb.x + hb.w - skin.anchor.x) * s,
    bodyUp: (skin.anchor.y - hb.y) * s,
  };
}

/**
 * @typedef {{ id: number, bounds: Rect, workArea: Rect }} DisplayLike
 * @typedef {{ x: number, y: number, width: number, height: number }} Rect
 * @typedef {{ id: string, left: number, right: number, top: number, display: number }} Perch
 *   left/right: 창 윗변에서 펫이 설 수 있는 가로 범위(모니터 안쪽으로 잘림), top: 창 윗변의 y, display: 그 모니터 ID
 */

/** 창 위에 올라가기엔 너무 작은 창 / 바닥과 너무 가까운 창은 제외한다. */
const MIN_WINDOW_HEIGHT = 80;
const MIN_RISE = 60;

/**
 * 활성 창이 펫이 올라설 만한 곳인지 판단한다.
 * @param {{ id: string, rect: Rect, minimized?: boolean, maximized?: boolean, fullscreen?: boolean }} win  rect: 보이는 창 영역(DIP)
 * @param {DisplayLike[]} displays
 * @param {{ bodyLeft: number, bodyRight: number, bodyUp: number }} m
 * @returns {Perch | null}
 */
export function computePerch(win, displays, m) {
  if (win.minimized || win.maximized || win.fullscreen) return null;
  const { x, y, width, height } = win.rect;
  if (height < MIN_WINDOW_HEIGHT) return null;

  // 윗변 가운데가 속한 모니터
  const cx = x + width / 2;
  const d = displays.find((k) => cx >= k.bounds.x && cx < k.bounds.x + k.bounds.width && y >= k.bounds.y && y < k.bounds.y + k.bounds.height);
  if (!d) return null;

  const ground = d.workArea.y + d.workArea.height;
  if (y < d.bounds.y + m.bodyUp + 4) return null; // 머리가 화면 위로 나간다
  if (ground - y < MIN_RISE) return null; // 바닥과 거의 같은 높이 (올라갈 이유가 없다)

  const left = Math.max(x, d.bounds.x);
  const right = Math.min(x + width, d.bounds.x + d.bounds.width);
  if (right - left < m.bodyLeft + m.bodyRight + 16) return null; // 몸이 들어가지 않는 좁은 창

  return { id: win.id, left, right, top: y, display: d.id };
}
