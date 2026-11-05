// @ts-check
// 이 창은 한 모니터를 담당한다. 펫 좌표는 가상 데스크톱 기준(전역)이고,
// 그릴 때 이 창의 원점(bounds.x/y)을 빼서 로컬 좌표로 바꾼다.
// 펫이 이 창의 모니터에 속해 있을 때만(isHome) 그린다.
import { positionAt } from '../shared/motion.js';
import { createChat } from './chat.js';

/** @type {any} */
const api = /** @type {any} */ (window).aipet;
const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('stage'));
const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));

const { displayId, bounds: initialBounds, skin, pet: initialPet, chat: initialChat, debug } = await api.init();
const chat = createChat(api, initialChat);

let origin = { x: initialBounds.x, y: initialBounds.y };
/** main이 보낸 펫 상태. 걷기/낙하 중 위치는 positionAt()으로 시간에서 계산한다. */
let pet = initialPet;
let interactive = false;
let dragging = false;
/** 펫 위에서 버튼을 눌렀지만 아직 드래그인지 클릭인지 모르는 상태 (누른 위치) */
/** @type {{ x: number, y: number } | null} */
let pressed = null;
const DRAG_THRESHOLD = 4;
/** @type {{ x: number, y: number } | null} 이 창 안의 마지막 포인터 위치 (펫이 움직일 때 호버 재판정용) */
let lastPointer = null;

// --- 스프라이트 시트 로딩 (없는 시트는 null → fallbacks로 대체) ---

/** @type {Map<string, HTMLImageElement | null>} */
const sheets = new Map();
await Promise.all(
  Object.entries(skin.animations).map(
    ([name, anim]) =>
      new Promise((resolve) => {
        const img = new Image();
        img.onload = () => resolve(sheets.set(name, img));
        img.onerror = () => resolve(sheets.set(name, null));
        img.src = `aipet-skin://${skin.name}/${anim.sheet}`;
      }),
  ),
);

/** skin.json에 폴백이 없을 때의 기본 대체 상태 */
const DEFAULT_FALLBACKS = /** @type {Record<string, string>} */ ({ fall: 'drag' });

/** 상태 이름 → 실제로 그릴 수 있는 애니메이션 이름. 최종 폴백은 idle, 그것도 없으면 null. @param {string} name */
function resolveAnim(name) {
  const seen = new Set();
  /** @type {string | undefined} */
  let n = name;
  while (n && !seen.has(n)) {
    if (sheets.get(n)) return n;
    seen.add(n);
    n = skin.fallbacks[n] ?? DEFAULT_FALLBACKS[n];
  }
  return sheets.get('idle') ? 'idle' : null;
}

/** @param {string} name @param {number} elapsedMs */
function frameOf(name, elapsedMs) {
  const a = skin.animations[name];
  const f = Math.max(0, Math.floor((elapsedMs / 1000) * a.fps));
  return a.loop === false ? Math.min(a.frames - 1, f) : f % a.frames;
}

// --- 좌표 ---

function isHome() {
  return pet.display === displayId;
}

/** 시트가 바라보는 방향과 펫의 진행 방향이 다르면 좌우 반전 */
function isFlipped() {
  return skin.flippable && pet.facing !== skin.facing;
}

/** 이 창 로컬 좌표계에서 본 펫의 스프라이트/히트박스 영역 @param {{x:number,y:number}} pos */
function petRects(pos) {
  const s = skin.scale;
  const { w: fw, h: fh } = skin.frameSize;
  const flip = isFlipped();
  const ax = flip ? fw - skin.anchor.x : skin.anchor.x;
  const hx = flip ? fw - (skin.hitbox.x + skin.hitbox.w) : skin.hitbox.x;
  const left = pos.x - origin.x - ax * s;
  const top = pos.y - origin.y - skin.anchor.y * s;
  return {
    sprite: { x: left, y: top, w: fw * s, h: fh * s },
    hit: { x: left + hx * s, y: top + skin.hitbox.y * s, w: skin.hitbox.w * s, h: skin.hitbox.h * s },
  };
}

/** @param {number} x @param {number} y 이 창 로컬 좌표 */
function hitTest(x, y) {
  if (!isHome()) return false;
  const { hit } = petRects(positionAt(pet, Date.now()));
  return x >= hit.x && x <= hit.x + hit.w && y >= hit.y && y <= hit.y + hit.h;
}

// --- 그리기 (바뀐 게 있을 때만, 이전 스프라이트 영역만 지우고 다시 그린다) ---

/** @type {{ x: number, y: number, w: number, h: number } | null} */
let lastRect = null;
let lastKey = '';

function resize() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(window.innerWidth * dpr);
  canvas.height = Math.round(window.innerHeight * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  lastRect = null;
  lastKey = '';
}

/** @param {{x:number,y:number,w:number,h:number}} r */
function clear(r) {
  ctx.clearRect(r.x - 2, r.y - 2, r.w + 4, r.h + 4);
}

/** @param {number} now */
function render(now) {
  if (!isHome()) {
    if (lastRect) clear(lastRect); // 펫이 다른 모니터로 갔으면 이 창은 비운다
    lastRect = null;
    lastKey = '';
    return;
  }

  const pos = positionAt(pet, now);
  const anim = resolveAnim(pet.anim);
  const frame = anim ? frameOf(anim, now - pet.t0) : 0;
  const flip = isFlipped();
  const key = [anim, frame, flip, pos.x.toFixed(1), pos.y.toFixed(1), debug && interactive].join('|');
  if (key === lastKey) return;
  lastKey = key;

  const { sprite: r, hit } = petRects(pos);
  if (lastRect) clear(lastRect);
  lastRect = r;

  const sheet = anim ? sheets.get(anim) : null;
  if (sheet) {
    const { w: fw, h: fh } = skin.frameSize;
    ctx.imageSmoothingEnabled = skin.scale % 1 !== 0 || skin.scale < 1;
    ctx.save();
    if (flip) {
      ctx.translate(r.x + r.w, r.y);
      ctx.scale(-1, 1);
      ctx.drawImage(sheet, frame * fw, 0, fw, fh, 0, 0, r.w, r.h);
    } else {
      ctx.drawImage(sheet, frame * fw, 0, fw, fh, r.x, r.y, r.w, r.h);
    }
    ctx.restore();
  } else {
    // 에셋이 전혀 없을 때의 임시 펫
    ctx.fillStyle = '#ffb585';
    ctx.beginPath();
    ctx.roundRect(hit.x, hit.y, hit.w, hit.h, hit.w / 2.5);
    ctx.fill();
  }

  if (debug) {
    ctx.strokeStyle = interactive ? '#00d26a' : '#ff3b30';
    ctx.strokeRect(hit.x, hit.y, hit.w, hit.h);
  }
}

/** @param {boolean} value */
function setInteractive(value) {
  if (value === interactive) return;
  interactive = value;
  api.setInteractive(value);
}

/** 이 좌표에서 마우스를 받아야 하는가: 펫 위 또는 말풍선 위 @param {number} x @param {number} y */
function wantsMouse(x, y) {
  return hitTest(x, y) || chat.contains(x, y);
}

function loop() {
  const now = Date.now();
  // 펫이 걸어 다니므로 포인터가 가만히 있어도 호버 여부가 바뀔 수 있다.
  if (!dragging && !pressed && lastPointer) setInteractive(wantsMouse(lastPointer.x, lastPointer.y));
  render(now);
  // 말풍선은 펫의 히트박스 위에 놓는다. 펫이 다른 모니터에 있으면 숨긴다.
  chat.layout(isHome() ? petRects(positionAt(pet, now)).hit : null, window.innerWidth, window.innerHeight);
  requestAnimationFrame(loop);
}

// --- 입력: 펫/말풍선 위에서만 마우스를 받고, 그 외에는 클릭 통과 ---
// 펫을 누른 뒤 거의 움직이지 않고 떼면 "클릭"(대화창 토글), 일정 거리 이상 움직이면 "드래그".

window.addEventListener('pointermove', (e) => {
  lastPointer = { x: e.clientX, y: e.clientY };
  if (pressed && !dragging && Math.hypot(e.clientX - pressed.x, e.clientY - pressed.y) > DRAG_THRESHOLD) {
    dragging = true;
    api.setDragging(true); // 드래그 중 이동은 main이 커서 위치로 직접 처리한다.
  } else if (!pressed && !dragging) {
    setInteractive(wantsMouse(e.clientX, e.clientY));
  }
});

document.documentElement.addEventListener('pointerleave', () => {
  lastPointer = null;
  if (!dragging && !pressed) setInteractive(false);
});

canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || !hitTest(e.clientX, e.clientY)) return;
  pressed = { x: e.clientX, y: e.clientY };
  // 드래그 중 포인터가 다른 모니터로 나가도 이 창이 계속 이벤트를 받는다.
  canvas.setPointerCapture(e.pointerId);
});

/** @param {PointerEvent} e @param {boolean} cancelled */
function release(e, cancelled) {
  const wasDragging = dragging;
  const wasClick = !!pressed && !dragging && !cancelled;
  pressed = null;
  dragging = false;
  if (wasDragging) api.setDragging(false);
  if (wasClick) api.petClick();
  lastPointer = { x: e.clientX, y: e.clientY };
  setInteractive(wantsMouse(e.clientX, e.clientY));
}
canvas.addEventListener('pointerup', (e) => release(e, false));
canvas.addEventListener('pointercancel', (e) => release(e, true));
canvas.addEventListener('lostpointercapture', (e) => release(e, true)); // 타이머가 멈추지 않는 일이 없도록

canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (hitTest(e.clientX, e.clientY)) api.showMenu();
});

// --- main → renderer ---

api.onPetState((/** @type {typeof pet} */ state) => {
  pet = state;
  lastKey = '';
  // 펫이 떠났으면 클릭 통과로 되돌린다. 이 창이 드래그를 잡고 있으면 드래그가 끝날 때 처리한다.
  if (!isHome() && !dragging) setInteractive(false);
});

api.onBounds((/** @type {{x:number,y:number}} */ b) => {
  origin = { x: b.x, y: b.y };
  resize();
});

window.addEventListener('resize', resize);
resize();
loop();
