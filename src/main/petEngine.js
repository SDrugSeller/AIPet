// @ts-check
// 펫의 행동 상태머신 (idle / walk / sleep / drag / fall / drop / 창 위로 jump 후 sit).
// 위치와 애니메이션 상태는 여기서만 바꾸고, 바뀔 때마다 emit()으로 모든 창에 알린다.
import { FALL_GRAVITY, moveDuration, positionAt } from '../shared/motion.js';
import { bodyMetrics } from './perch.js';

/** @param {number} a @param {number} b */
const rand = (a, b) => a + Math.random() * (b - a);
/** @param {number} v @param {number} lo @param {number} hi */
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

/** 창에서 내려온 뒤, 다시 올라가기까지 최소로 쉬는 시간 */
const PERCH_COOLDOWN_MS = 45_000;
/** 쉬는 동안 다음 행동을 고를 때 창에 올라가기로 할 확률 */
const PERCH_CHANCE = 0.4;

/**
 * @typedef {{ left: number, right: number, ground: number }} Area
 *   펫이 서 있을 수 있는 영역: 발 x 범위와 바닥 y (작업표시줄 위)
 *
 * @param {{
 *   skin: any,
 *   area: (displayId: number) => Area | null,
 *   emit: () => void,
 *   sleepAfterMs: number,
 * }} opts
 */
export function createPetEngine({ skin, area, emit, sleepAfterMs }) {
  const pet = {
    display: 0,
    x: 0,
    y: 0,
    dragging: false,
    /** @type {string} 재생할 애니메이션 이름 (없으면 렌더러가 fallbacks로 대체) */
    anim: 'idle',
    /** @type {'left' | 'right'} */
    facing: 'left',
    t0: Date.now(),
    /** @type {import('../shared/motion.js').Move | null} */
    move: null,
  };

  const { bodyLeft, bodyRight } = bodyMetrics(skin);

  /** @type {NodeJS.Timeout | null} */
  let timer = null;
  let lastActive = Date.now();

  /** @param {number} ms @param {() => void} fn */
  function after(ms, fn) {
    clearTimer();
    timer = setTimeout(fn, ms);
  }
  function clearTimer() {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  /** 진행 중인 이동을 현재 위치에서 멈춘다. */
  function settle() {
    const p = positionAt(pet, Date.now());
    pet.x = p.x;
    pet.y = p.y;
    pet.move = null;
  }

  /** @param {string} anim @param {import('../shared/motion.js').Move | null} [move] */
  function setAnim(anim, move = null) {
    pet.anim = anim;
    pet.move = move;
    pet.t0 = Date.now();
  }

  /** @param {string} name */
  function animDuration(name) {
    const a = skin.animations[name];
    return a ? (a.frames / a.fps) * 1000 : 400;
  }

  // 에이전트 연동 상태(think/work/talk/done/error)는 일반 행동보다 우선한다 (DESIGN.md 5.3).
  /** @type {string | null} */
  let agentAnim = null;
  let agentOnce = false;
  /** 대화창이 열려 있는 동안은 돌아다니지 않고 제자리에 있는다. */
  let hold = false;

  // --- 창 위에 올라가기 ---
  /** 지금 올라갈 수 있는 창 (활성 창을 perch.js가 판정한 결과). 없으면 null */
  /** @type {import('./perch.js').Perch | null} */
  let target = null;
  /** 지금 올라서 있는 창의 id */
  /** @type {string | null} */
  let perched = null;
  /** 창 왼쪽 끝에서 펫까지의 거리 (창이 움직이면 같은 자리에 머물도록) */
  let perchOffset = 0;
  let perchUntil = 0;
  let lastPerchEnd = 0;

  /** @param {import('./perch.js').Perch} t */
  const perchArea = (t) => ({ left: t.left + bodyLeft, right: t.right - bodyRight, ground: t.top });
  /** 지금 서 있는 곳의 영역: 창 위면 창 윗변, 아니면 바닥 */
  const standArea = () => (perched && target && target.id === perched ? perchArea(target) : area(pet.display));

  /** 낙하/점프/착지 중에는 애니메이션을 바꾸지 않는다 (끝나면 enterIdle이 반영한다). */
  const busyMoving = () => pet.dragging || pet.anim === 'fall' || pet.anim === 'drop' || pet.anim === 'jump';

  function enterIdle() {
    settle();
    if (agentAnim) {
      const name = agentAnim;
      pet.facing = skin.facing ?? 'left'; // 시트에 그려진 글자/효과가 좌우로 뒤집히지 않게
      setAnim(name);
      emit();
      if (agentOnce) {
        after(animDuration(name), () => {
          agentAnim = null;
          agentOnce = false;
          enterIdle();
        });
      } else {
        clearTimer();
      }
      return;
    }
    setAnim(perched ? 'sit' : 'idle'); // 창 위에서는 걸터앉은 자세 (시트가 없으면 idle로 대체된다)
    emit();
    if (hold) clearTimer();
    else after(rand(3000, 8000), decide);
  }

  /** 쉬는 시간이 끝났을 때 다음 행동을 고른다. */
  function decide() {
    if (perched) return decidePerched();
    if (Date.now() - lastActive > sleepAfterMs) return enterSleep();
    if (target && target.display === pet.display && Date.now() - lastPerchEnd > PERCH_COOLDOWN_MS && Math.random() < PERCH_CHANCE) {
      return goToPerch();
    }
    if (Math.random() < 0.7) return enterWalk();
    after(rand(3000, 8000), decide); // idle 유지 (애니메이션은 재시작하지 않는다)
  }

  function decidePerched() {
    // 창이 사라졌거나 활성 창이 바뀌었거나 충분히 쉬었으면 내려간다.
    if (!target || target.id !== perched || Date.now() >= perchUntil) return fallToGround();
    if (Math.random() < 0.4) return enterWalk(); // 창 가장자리를 따라 거닌다
    after(rand(3000, 8000), decide);
  }

  /** @param {number} x1 @param {() => void} onArrive */
  function startWalk(x1, onArrive) {
    settle();
    pet.facing = x1 < pet.x ? 'left' : 'right';
    const speed = skin.animations.walk?.moveSpeed ?? 60;
    setAnim('walk', { kind: 'walk', x1, speed });
    emit();
    after(moveDuration(pet), () => {
      pet.x = x1;
      pet.move = null;
      onArrive();
    });
  }

  function enterWalk() {
    const a = standArea();
    if (!a) return enterIdle();
    let x1 = rand(a.left, a.right);
    for (let i = 0; i < 5 && Math.abs(x1 - pet.x) < 150; i++) x1 = rand(a.left, a.right);
    if (Math.abs(x1 - pet.x) < 40) return enterIdle();
    startWalk(x1, enterIdle);
  }

  function enterSleep() {
    settle();
    pet.facing = skin.facing ?? 'left';
    setAnim('sleep');
    emit();
    clearTimer(); // 사용자가 건드릴 때까지 유지
  }

  /** 착지: 눌렸다가 일어서는 동작 후 다음 행동 */
  function land() {
    pet.move = null;
    setAnim('drop');
    emit();
    after(animDuration('drop'), enterIdle);
  }

  /** 지금 있는 곳(바닥 또는 창 위)에서 바닥으로 내려온다. */
  function fallToGround() {
    if (perched) lastPerchEnd = Date.now();
    perched = null;
    const a = area(pet.display);
    if (!a) return enterIdle();
    settle();
    pet.x = clamp(pet.x, a.left, a.right);
    if (pet.y >= a.ground - 1) {
      pet.y = a.ground;
      return land();
    }
    setAnim('fall', { kind: 'fall', y1: a.ground, g: FALL_GRAVITY });
    emit();
    after(moveDuration(pet), () => {
      pet.y = a.ground;
      land();
    });
  }

  /** 창 아래까지 걸어가서 뛰어오른다. */
  function goToPerch() {
    const t = target;
    if (!t) return enterIdle();
    const pa = perchArea(t);
    const x = clamp(pet.x, pa.left, pa.right);
    if (Math.abs(x - pet.x) > 24) startWalk(x, () => jumpUp(t.id, x));
    else jumpUp(t.id, x);
  }

  /** @param {string} id @param {number} x */
  function jumpUp(id, x) {
    const t = target;
    if (!t || t.id !== id) return enterIdle(); // 걸어가는 사이 활성 창이 바뀌었다
    settle();
    const pa = perchArea(t);
    const x1 = clamp(x, pa.left, pa.right);
    const rise = pet.y - t.top;
    const dur = Math.min(900, 450 + Math.abs(rise) * 0.6);
    setAnim('jump', { kind: 'jump', x1, y1: t.top, dur, height: 30 + Math.min(80, Math.abs(rise) * 0.15) });
    emit();
    after(dur, () => landOnPerch(id, x1));
  }

  /** @param {string} id @param {number} x1 */
  function landOnPerch(id, x1) {
    const t = target;
    if (!t || t.id !== id) {
      // 뛰는 사이 창이 사라졌다: 그 자리에서 떨어진다.
      settle();
      pet.x = x1;
      pet.move = null;
      return fallToGround();
    }
    pet.x = x1;
    pet.y = t.top;
    pet.display = t.display;
    pet.move = null;
    perched = id;
    perchOffset = x1 - t.left;
    perchUntil = Date.now() + rand(25_000, 70_000);
    land();
  }

  return {
    pet,

    /** 지금 창 위에 올라서 있는가 (테스트/디버그용) */
    get perchedOn() {
      return perched;
    },

    /** 처음 위치를 정하고 행동을 시작한다. */
    start(/** @type {number} */ display, /** @type {number} */ x) {
      pet.display = display;
      pet.x = x;
      pet.y = area(display)?.ground ?? 0;
      lastActive = Date.now();
      enterIdle();
    },

    /** 사용자가 펫을 건드렸다 (클릭, 대화 등). 자고 있으면 깨운다. */
    poke() {
      lastActive = Date.now();
      if (pet.anim === 'sleep') enterIdle();
    },

    /** 대화창이 열려 있는 동안 제자리에 머문다. */
    setHold(/** @type {boolean} */ value) {
      if (hold === value) return;
      hold = value;
      if (!busyMoving()) enterIdle();
    },

    /**
     * 에이전트 상태 애니메이션을 재생한다. null이면 일반 행동으로 복귀.
     * once=true면 한 번 재생한 뒤 자동으로 복귀한다 (done, error).
     */
    setAgentAnim(/** @type {string | null} */ name, /** @type {{ once?: boolean }} */ { once = false } = {}) {
      if (name === agentAnim && once === agentOnce) return;
      agentAnim = name;
      agentOnce = name !== null && once;
      if (!busyMoving()) enterIdle();
    },

    /**
     * 올라갈 수 있는 활성 창이 바뀌었다 (없으면 null).
     * 올라서 있는 창이 움직이면 같이 움직이고, 활성 창이 바뀌면 내려온다.
     * @param {import('./perch.js').Perch | null} t
     */
    setTarget(t) {
      target = t;
      if (!perched || pet.dragging) return;
      if (!t || t.id !== perched) {
        if (pet.anim !== 'fall' && pet.anim !== 'drop' && pet.anim !== 'jump') fallToGround();
        return; // 낙하/착지 중이면 끝난 뒤 바닥에 서 있게 된다
      }
      // 같은 창이 움직이거나 크기가 바뀌었다: 윗변 위의 같은 자리에 머문다.
      const pa = perchArea(t);
      settle();
      const x = clamp(t.left + perchOffset, pa.left, pa.right);
      const changed = pet.x !== x || pet.y !== t.top || pet.display !== t.display;
      if (!changed) return;
      const walking = pet.anim === 'walk';
      pet.x = x;
      pet.y = t.top;
      pet.display = t.display;
      perchOffset = x - t.left;
      if (walking) enterIdle(); // 걷던 중이면 멈추고 새 자리에서 이어간다
      else emit();
    },

    startDrag() {
      clearTimer();
      settle();
      if (perched) lastPerchEnd = Date.now();
      perched = null; // 사용자가 집어 올렸다
      lastActive = Date.now();
      pet.dragging = true;
      setAnim('drag');
      emit();
    },

    endDrag() {
      pet.dragging = false;
      lastActive = Date.now();
      fallToGround();
    },

    /** 모니터 구성이 바뀐 뒤 바닥에 다시 세운다. */
    relayout() {
      if (pet.dragging) return;
      perched = null;
      const a = area(pet.display);
      if (a) {
        pet.x = clamp(pet.x, a.left, a.right);
        pet.y = a.ground;
      }
      enterIdle();
    },
  };
}
