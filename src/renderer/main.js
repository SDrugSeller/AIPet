// @ts-check
// 이 창은 한 모니터를 담당한다. 펫 좌표는 가상 데스크톱 기준(전역)이고,
// 그릴 때 이 창의 원점(bounds.x/y)을 빼서 로컬 좌표로 바꾼다.
// 펫은 연결 하나당 한 마리이고, 각 펫은 자기 모니터의 창에서만(isHome) 그려진다.
import { positionAt } from '../shared/motion.js';
import { createChat, refocusActiveChat } from './chat.js';

/** @type {any} */
const api = /** @type {any} */ (window).aipet;
const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('stage'));
const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));
const layer = /** @type {HTMLElement} */ (document.getElementById('layer'));
const template = /** @type {HTMLTemplateElement} */ (document.getElementById('pet-ui'));

const { displayId, bounds: initialBounds, pets: initialPets, debug, logging } = await api.init();

let origin = { x: initialBounds.x, y: initialBounds.y };

/**
 * 펫 한 마리. state는 main이 보낸 상태로, 걷기/낙하 중 위치는 positionAt()으로 시간에서 계산한다.
 * @typedef {{
 *   id: string, name: string, skin: any, skinKey: string,
 *   sheets: Map<string, HTMLImageElement | null> | null,
 *   state: any,
 *   chat: ReturnType<typeof createChat>,
 * }} Pet
 */
/** @type {Map<string, Pet>} */
const pets = new Map();
/** 그리는 순서(아래 → 위). 마지막으로 누른 펫이 맨 위로 온다. */
/** @type {string[]} */
let drawOrder = [];

let interactive = false;
/** 드래그 중인 펫의 id */
/** @type {string | null} */
let dragging = null;
/** 펫 위에서 버튼을 눌렀지만 아직 드래그인지 클릭인지 모르는 상태 (누른 펫과 위치) */
/** @type {{ petId: string, x: number, y: number } | null} */
let pressed = null;
const DRAG_THRESHOLD = 4;
/** @type {{ x: number, y: number } | null} 이 창 안의 마지막 포인터 위치 (펫이 움직일 때 호버 재판정용) */
let lastPointer = null;

// --- 스프라이트 시트 로딩 (없는 시트는 null → fallbacks로 대체). 같은 스킨은 한 번만 읽는다. ---

/** @type {Map<string, Promise<Map<string, HTMLImageElement | null>>>} */
const sheetCache = new Map();

/** @param {any} skin */
function loadSheets(skin) {
  let p = sheetCache.get(skin.name);
  if (!p) {
    p = (async () => {
      /** @type {Map<string, HTMLImageElement | null>} */
      const sheets = new Map();
      await Promise.all(
        Object.entries(skin.animations).map(
          ([name, anim]) =>
            new Promise((resolve) => {
              const img = new Image();
              img.onload = () => resolve(sheets.set(name, img));
              img.onerror = () => resolve(sheets.set(name, null));
              img.src = `aipet-skin://${skin.name}/${/** @type {any} */ (anim).sheet}`;
            }),
        ),
      );
      return sheets;
    })();
    sheetCache.set(skin.name, p);
  }
  return p;
}

/** skin.json에 폴백이 없을 때의 기본 대체 상태 */
const DEFAULT_FALLBACKS = /** @type {Record<string, string>} */ ({ fall: 'drag', jump: 'drag', sit: 'idle' });

/** 상태 이름 → 실제로 그릴 수 있는 애니메이션 이름. 최종 폴백은 idle, 그것도 없으면 null. @param {Pet} p @param {string} name */
function resolveAnim(p, name) {
  const seen = new Set();
  /** @type {string | undefined} */
  let n = name;
  while (n && !seen.has(n)) {
    if (p.sheets?.get(n)) return n;
    seen.add(n);
    n = p.skin.fallbacks[n] ?? DEFAULT_FALLBACKS[n];
  }
  return p.sheets?.get('idle') ? 'idle' : null;
}

/** @param {Pet} p @param {string} name @param {number} elapsedMs */
function frameOf(p, name, elapsedMs) {
  const a = p.skin.animations[name];
  const f = Math.max(0, Math.floor((elapsedMs / 1000) * a.fps));
  return a.loop === false ? Math.min(a.frames - 1, f) : f % a.frames;
}

// --- 좌표 ---

/** @param {Pet} p */
const isHome = (p) => p.state.display === displayId;

/** 시트가 바라보는 방향과 펫의 진행 방향이 다르면 좌우 반전 @param {Pet} p */
const isFlipped = (p) => p.skin.flippable && p.state.facing !== p.skin.facing;

/** 이 창 로컬 좌표계에서 본 펫의 스프라이트/히트박스 영역 @param {Pet} p @param {{x:number,y:number}} pos */
function petRects(p, pos) {
  const { skin } = p;
  const s = skin.scale;
  const { w: fw, h: fh } = skin.frameSize;
  const flip = isFlipped(p);
  const ax = flip ? fw - skin.anchor.x : skin.anchor.x;
  const hx = flip ? fw - (skin.hitbox.x + skin.hitbox.w) : skin.hitbox.x;
  const left = pos.x - origin.x - ax * s;
  const top = pos.y - origin.y - skin.anchor.y * s;
  return {
    sprite: { x: left, y: top, w: fw * s, h: fh * s },
    hit: { x: left + hx * s, y: top + skin.hitbox.y * s, w: skin.hitbox.w * s, h: skin.hitbox.h * s },
  };
}

/** 이 좌표(이 창 로컬)에 있는 가장 위의 펫 @param {number} x @param {number} y @returns {Pet | null} */
function topPetAt(x, y) {
  const now = Date.now();
  for (let i = drawOrder.length - 1; i >= 0; i--) {
    const p = pets.get(drawOrder[i]);
    if (!p || !isHome(p)) continue;
    const { hit } = petRects(p, positionAt(p.state, now));
    if (x >= hit.x && x <= hit.x + hit.w && y >= hit.y && y <= hit.y + hit.h) return p;
  }
  return null;
}

// --- 그리기 (바뀐 게 있을 때만, 이전에 그린 영역만 지우고 모든 펫을 다시 그린다) ---

/** @type {{ x: number, y: number, w: number, h: number }[]} */
let lastRects = [];
let lastKey = '';

function resize() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(window.innerWidth * dpr);
  canvas.height = Math.round(window.innerHeight * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  lastRects = [];
  lastKey = '';
}

/** @param {number} now */
function render(now) {
  /** @type {{ p: Pet, pos: { x: number, y: number }, anim: string | null, frame: number, flip: boolean }[]} */
  const items = [];
  for (const id of drawOrder) {
    const p = pets.get(id);
    if (!p || !isHome(p)) continue;
    const pos = positionAt(p.state, now);
    const anim = resolveAnim(p, p.state.anim);
    items.push({ p, pos, anim, frame: anim ? frameOf(p, anim, now - p.state.t0) : 0, flip: isFlipped(p) });
  }

  // 키는 절대 빈 문자열이 되면 안 된다. lastKey = ''는 "다시 그려야 함"이라는 뜻이라서, 펫이 다른 모니터로 가서
  // 이 창에 그릴 펫이 없을 때(키가 빈 문자열)에 지우기를 건너뛰어 이전 모습이 잔상으로 남는다.
  const key = 'k:' + items
    .map((i) => [i.p.id, i.anim, i.frame, i.flip, i.pos.x.toFixed(1), i.pos.y.toFixed(1), !!i.p.sheets].join(','))
    .join('|') + (debug ? `|${interactive}` : '');
  if (key === lastKey) return;
  lastKey = key;

  // 이전 프레임에 그린 영역을 모두 지우고 다시 그린다 (펫끼리 겹쳐도 깨지지 않는다)
  for (const r of lastRects) ctx.clearRect(r.x - 2, r.y - 2, r.w + 4, r.h + 4);
  lastRects = [];

  for (const { p, pos, anim, frame, flip } of items) {
    const { sprite: r, hit } = petRects(p, pos);
    lastRects.push(r);
    const sheet = anim ? p.sheets?.get(anim) : null;
    if (sheet) {
      const { w: fw, h: fh } = p.skin.frameSize;
      ctx.imageSmoothingEnabled = !p.skin.pixelArt; // 일러스트는 부드럽게, 도트는 선명하게
      ctx.imageSmoothingQuality = 'high';
      ctx.save();
      if (flip) {
        ctx.translate(r.x + r.w, r.y);
        ctx.scale(-1, 1);
        ctx.drawImage(sheet, frame * fw, 0, fw, fh, 0, 0, r.w, r.h);
      } else {
        ctx.drawImage(sheet, frame * fw, 0, fw, fh, r.x, r.y, r.w, r.h);
      }
      ctx.restore();
    } else if (p.sheets) {
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
}

/** @param {boolean} value */
function setInteractive(value) {
  if (value === interactive) return;
  interactive = value;
  api.setInteractive(value);
}

/** 이 좌표에서 마우스를 받아야 하는가: 펫 위 또는 어느 말풍선 위 @param {number} x @param {number} y */
function wantsMouse(x, y) {
  if (topPetAt(x, y)) return true;
  for (const p of pets.values()) if (p.chat.contains(x, y)) return true;
  return false;
}

function loop() {
  const now = Date.now();
  // 펫이 걸어 다니므로 포인터가 가만히 있어도 호버 여부가 바뀔 수 있다.
  if (!dragging && !pressed && lastPointer) setInteractive(wantsMouse(lastPointer.x, lastPointer.y));
  render(now);
  // 말풍선은 각 펫의 히트박스 위에 놓는다. 펫이 다른 모니터에 있으면 숨긴다.
  for (const p of pets.values()) {
    p.chat.layout(isHome(p) ? petRects(p, positionAt(p.state, now)).hit : null, window.innerWidth, window.innerHeight);
  }
  requestAnimationFrame(loop);
}

// --- 입력: 펫/말풍선 위에서만 마우스를 받고, 그 외에는 클릭 통과 ---
// 펫을 누른 뒤 거의 움직이지 않고 떼면 "클릭"(대화창 토글), 일정 거리 이상 움직이면 "드래그".

/** 마지막으로 마우스 이동 이벤트를 받은 시각. 이벤트가 정상적으로 오는 동안에는 main이 읽어 준 커서 위치를 쓰지 않는다. */
let lastRealMove = -Infinity;

/** 디버그 전용: 드래그 수명 주기 기록 @param {...any} a */
const dlog = (...a) => logging && console.log('[drag:renderer]', ...a);
let noButtonLogged = false;

window.addEventListener('pointermove', (e) => {
  lastRealMove = performance.now();
  lastPointer = { x: e.clientX, y: e.clientY };
  if ((pressed || dragging) && e.buttons === 0 && !noButtonLogged) {
    noButtonLogged = true;
    dlog('버튼이 이미 떼어졌는데 드래그/누름 상태가 남아 있음', e.type, `client=${e.clientX},${e.clientY}`, 'pressed=', !!pressed, 'dragging=', dragging);
  }
  if (pressed && !dragging && Math.hypot(e.clientX - pressed.x, e.clientY - pressed.y) > DRAG_THRESHOLD) {
    dragging = pressed.petId;
    api.setDragging(dragging, true); // 드래그 중 이동은 main이 커서 위치로 직접 처리한다.
  } else if (!pressed && !dragging) {
    setInteractive(wantsMouse(e.clientX, e.clientY));
  }
});

// 보조 경로: 클릭 통과 중에 마우스 이동 이벤트가 오지 않으면(Windows가 마우스 훅을 떼어 낸 경우) main이 읽어 준 커서 위치로
// 펫 위인지 판단한다. 이게 없으면 펫이 마우스가 올라온 줄 모르고 모든 클릭이 아래 창으로 새어 나간다.
api.onCursor((/** @type {{ x: number, y: number } | null} */ c) => {
  if (performance.now() - lastRealMove < 200) return; // 정상 경로가 동작 중이다
  if (!c) {
    if (lastPointer) {
      lastPointer = null;
      if (!dragging && !pressed) setInteractive(false);
    }
    return;
  }
  lastPointer = { x: c.x - origin.x, y: c.y - origin.y };
  if (!dragging && !pressed) {
    const want = wantsMouse(lastPointer.x, lastPointer.y);
    if (logging && want !== interactive) console.log('[cursor-fallback]', want ? '펫 위: 마우스 받기' : '펫 밖: 클릭 통과');
    setInteractive(want);
  }
});

window.addEventListener('blur', () => dlog('window blur', 'pressed=', !!pressed, 'dragging=', dragging));
window.addEventListener('focus', () => dlog('window focus'));

document.documentElement.addEventListener('pointerleave', () => {
  if (pressed || dragging) dlog('pointerleave while pressed/dragging', 'dragging=', dragging);
  lastPointer = null;
  if (!dragging && !pressed) setInteractive(false);
});

// 펫을 눌러도 대화창 입력칸의 포커스를 빼앗지 않는다 (누르는 동작의 기본 효과가 포커스 이동이다)
canvas.addEventListener('mousedown', (e) => e.preventDefault());

canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0) return;
  const p = topPetAt(e.clientX, e.clientY);
  if (!p) return;
  noButtonLogged = false;
  dlog('pointerdown', p.id, `client=${e.clientX},${e.clientY}`, 'buttons=', e.buttons);
  pressed = { petId: p.id, x: e.clientX, y: e.clientY };
  // 누른 펫을 맨 위로 올린다
  drawOrder = [...drawOrder.filter((id) => id !== p.id), p.id];
  lastKey = '';
  // 드래그 중 포인터가 다른 모니터로 나가도 이 창이 계속 이벤트를 받는다.
  canvas.setPointerCapture(e.pointerId);
});

/** @param {PointerEvent} e @param {boolean} cancelled */
function release(e, cancelled) {
  if (pressed || dragging) dlog('release', e.type, 'cancelled=', cancelled, `client=${e.clientX},${e.clientY}`, 'buttons=', e.buttons, 'dragging=', dragging);
  const wasDragging = dragging;
  const clicked = pressed && !dragging && !cancelled ? pressed.petId : null;
  pressed = null;
  dragging = null;
  if (wasDragging) api.setDragging(wasDragging, false);
  if (clicked) api.petClick(clicked);
  lastPointer = { x: e.clientX, y: e.clientY };
  setInteractive(wantsMouse(e.clientX, e.clientY));
  if (wasDragging || clicked) refocusActiveChat(); // 끌거나 눌러서 풀린 입력칸 포커스를 되돌린다
}
canvas.addEventListener('pointerup', (e) => release(e, false));
canvas.addEventListener('pointercancel', (e) => release(e, true));
canvas.addEventListener('lostpointercapture', (e) => release(e, true)); // 타이머가 멈추지 않는 일이 없도록

canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  const p = topPetAt(e.clientX, e.clientY);
  if (p) api.showMenu(p.id);
});

// --- main → renderer ---

/** 펫을 새로 만들거나, 이미 있으면 이름/스킨/상태를 갱신한다. @param {any} d */
function upsertPet(d) {
  const skinKey = JSON.stringify(d.skin);
  let p = pets.get(d.id);
  if (!p) {
    p = { id: d.id, name: d.name, skin: d.skin, skinKey, sheets: null, state: d.state, chat: createChat(api, d, layer, template) };
    pets.set(d.id, p);
    drawOrder.push(d.id);
    if (d.notice) p.chat.showNotice(d.notice); // 창이 열리기 전에 뜬 알림(설정 안내 등)도 보여 준다
  } else {
    p.name = d.name;
    p.chat.setName(d.name);
    p.state = d.state;
    if (p.skinKey !== skinKey) {
      p.skin = d.skin;
      p.skinKey = skinKey;
      p.sheets = null;
    }
  }
  const target = p;
  if (!target.sheets) {
    void loadSheets(d.skin).then((s) => {
      if (target.skinKey === skinKey) {
        target.sheets = s;
        lastKey = '';
      }
    });
  }
  lastKey = '';
  return p;
}

api.onPetsSync((/** @type {any[]} */ list) => {
  const alive = new Set(list.map((d) => d.id));
  for (const d of list) upsertPet(d);
  for (const [id, p] of [...pets]) {
    if (alive.has(id)) continue;
    p.chat.dispose();
    pets.delete(id);
    if (dragging === id) dragging = null;
    if (pressed?.petId === id) pressed = null;
  }
  drawOrder = drawOrder.filter((id) => pets.has(id));
  lastKey = '';
});

api.onPetState((/** @type {any} */ s) => {
  const p = pets.get(s.id);
  if (!p) return;
  p.state = s;
  lastKey = '';
});

// 대화/권한/알림 이벤트는 petId로 해당 펫의 말풍선에 전달한다.
api.onChatState((/** @type {any} */ s) => pets.get(s.petId)?.chat.handleState(s));
api.onChatUser((/** @type {any} */ m) => pets.get(m.petId)?.chat.handleUser(m));
api.onAgentEvent((/** @type {any} */ ev) => pets.get(ev.petId)?.chat.handleAgent(ev));
api.onPermRequest((/** @type {any} */ r) => pets.get(r.petId)?.chat.handlePermRequest(r));
api.onPermResolved((/** @type {any} */ r) => pets.get(r.petId)?.chat.handlePermResolved(r));
api.onNoticeShow((/** @type {any} */ n) => pets.get(n.petId)?.chat.showNotice(n));
api.onNoticeHide((/** @type {any} */ n) => pets.get(n.petId)?.chat.hideNotice());

api.onBounds((/** @type {{x:number,y:number}} */ b) => {
  origin = { x: b.x, y: b.y };
  resize();
});

for (const d of initialPets) upsertPet(d);
await Promise.all([...pets.values()].map((p) => loadSheets(p.skin).then((s) => (p.sheets = s))));

window.addEventListener('resize', resize);
resize();
loop();
