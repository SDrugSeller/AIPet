// @ts-check
// 이 창은 한 모니터를 담당한다. 펫 좌표는 가상 데스크톱 기준(전역)이고,
// 그릴 때 이 창의 원점(bounds.x/y)을 빼서 로컬 좌표로 바꾼다.

/** @type {any} */
const api = /** @type {any} */ (window).aipet;
const canvas = /** @type {HTMLCanvasElement} */ (document.getElementById('stage'));
const ctx = /** @type {CanvasRenderingContext2D} */ (canvas.getContext('2d'));

const { displayId, bounds: initialBounds, skin, pet: initialPet, debug } = await api.init();

if (debug) console.log('init', JSON.stringify({ initialBounds, pet: initialPet, inner: [window.innerWidth, window.innerHeight], dpr: window.devicePixelRatio }));
window.addEventListener('error', (e) => console.log('error', e.message));

let origin = { x: initialBounds.x, y: initialBounds.y };
let pet = initialPet;
let interactive = false;

let dragging = false;

// idle 시트의 첫 프레임만 쓴다 (애니메이션은 M2). 이미지가 없으면 임시 도형으로 대체.
/** @type {HTMLImageElement | null} */
let sprite = null;
{
  const img = new Image();
  img.src = `aipet-skin://${skin.name}/${skin.animations.idle.sheet}`;
  img.onload = () => {
    sprite = img;
    draw();
  };
}

function resize() {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(window.innerWidth * dpr);
  canvas.height = Math.round(window.innerHeight * dpr);
  draw();
}

/** 펫이 이 창의 모니터에 있는지 */
function isHome() {
  return pet.display === displayId;
}

/** 이 창 로컬 좌표계에서 본 펫의 스프라이트/히트박스 영역 */
function petRects() {
  const s = skin.scale;
  const left = pet.x - origin.x - skin.anchor.x * s;
  const top = pet.y - origin.y - skin.anchor.y * s;
  return {
    sprite: { x: left, y: top, w: skin.frameSize.w * s, h: skin.frameSize.h * s },
    hit: {
      x: left + skin.hitbox.x * s,
      y: top + skin.hitbox.y * s,
      w: skin.hitbox.w * s,
      h: skin.hitbox.h * s,
    },
  };
}

function draw() {
  const dpr = window.devicePixelRatio || 1;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, window.innerWidth, window.innerHeight);
  if (!isHome()) return; // 펫이 다른 모니터에 있으면 이 창은 비워 둔다

  const { sprite: r, hit } = petRects();
  if (debug) console.log('draw', JSON.stringify({ hit, canvas: [canvas.width, canvas.height], sprite: !!sprite }));
  if (sprite) {
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(sprite, 0, 0, skin.frameSize.w, skin.frameSize.h, r.x, r.y, r.w, r.h);
  } else {
    // 에셋이 없을 때의 임시 펫
    ctx.fillStyle = pet.dragging ?'#ff9f6b' : '#ffb585';
    ctx.beginPath();
    ctx.roundRect(hit.x, hit.y, hit.w, hit.h, hit.w / 2.5);
    ctx.fill();
    ctx.fillStyle = '#222';
    const ey = hit.y + hit.h * 0.38;
    ctx.beginPath();
    ctx.arc(hit.x + hit.w * 0.33, ey, 4, 0, Math.PI * 2);
    ctx.arc(hit.x + hit.w * 0.67, ey, 4, 0, Math.PI * 2);
    ctx.fill();
  }

  if (debug) {
    ctx.strokeStyle = interactive ? '#00d26a' : '#ff3b30';
    ctx.strokeRect(hit.x, hit.y, hit.w, hit.h);
  }
}

/** @param {number} x @param {number} y 이 창 로컬 좌표 */
function hitTest(x, y) {
  if (!isHome()) return false;
  const { hit } = petRects();
  return x >= hit.x && x <= hit.x + hit.w && y >= hit.y && y <= hit.y + hit.h;
}

/** @param {boolean} value */
function setInteractive(value) {
  if (value === interactive) return;
  interactive = value;
  api.setInteractive(value);
  if (debug) draw();
}

// --- 입력: 펫 위에서만 마우스를 받고, 그 외에는 클릭 통과 ---

window.addEventListener('pointermove', (e) => {
  // 드래그 중 이동은 main이 커서 위치로 직접 처리한다.
  if (!dragging) setInteractive(hitTest(e.clientX, e.clientY));
});

canvas.addEventListener('pointerdown', (e) => {
  if (e.button !== 0 || !hitTest(e.clientX, e.clientY)) return;
  dragging = true;
  // 드래그 중 포인터가 다른 모니터로 나가도 이 창이 계속 이벤트를 받는다.
  canvas.setPointerCapture(e.pointerId);
  api.setDragging(true);
});

/** @param {PointerEvent} e */
function endDrag(e) {
  if (!dragging) return;
  dragging = false;
  api.setDragging(false);
  setInteractive(hitTest(e.clientX, e.clientY));
}
canvas.addEventListener('pointerup', endDrag);
canvas.addEventListener('pointercancel', endDrag);
canvas.addEventListener('lostpointercapture', endDrag); // 타이머가 멈추지 않는 일이 없도록

canvas.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  if (hitTest(e.clientX, e.clientY)) api.showMenu();
});

// --- main → renderer ---

api.onPetState((/** @type {typeof pet} */ state) => {
  pet = state;
  // 펫이 떠났으면 클릭 통과로 되돌린다. 단, 이 창이 드래그를 잡고 있으면 드래그가 끝날 때 처리한다.
  if (!isHome() && !dragging) setInteractive(false);
  draw();
});

api.onBounds((/** @type {{x:number,y:number}} */ b) => {
  origin = { x: b.x, y: b.y };
  resize();
});

window.addEventListener('resize', resize);
resize();
