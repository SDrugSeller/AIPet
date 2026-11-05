// @ts-check
// 펫의 행동 상태머신 (M2: idle / walk / sleep / drag / fall / drop).
// 위치와 애니메이션 상태는 여기서만 바꾸고, 바뀔 때마다 emit()으로 모든 창에 알린다.
import { FALL_GRAVITY, moveDuration, positionAt } from '../shared/motion.js';

/** @param {number} a @param {number} b */
const rand = (a, b) => a + Math.random() * (b - a);

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

  /** 낙하/착지 중에는 애니메이션을 바꾸지 않는다 (끝나면 enterIdle이 반영한다). */
  const busyMoving = () => pet.dragging || pet.anim === 'fall' || pet.anim === 'drop';

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
    setAnim('idle');
    emit();
    if (hold) clearTimer();
    else after(rand(3000, 8000), decide);
  }

  /** idle이 끝났을 때 다음 행동을 고른다. */
  function decide() {
    if (Date.now() - lastActive > sleepAfterMs) return enterSleep();
    if (Math.random() < 0.7) return enterWalk();
    after(rand(3000, 8000), decide); // idle 유지 (애니메이션은 재시작하지 않는다)
  }

  function enterWalk() {
    const a = area(pet.display);
    if (!a) return enterIdle();
    let x1 = rand(a.left, a.right);
    for (let i = 0; i < 5 && Math.abs(x1 - pet.x) < 150; i++) x1 = rand(a.left, a.right);
    if (Math.abs(x1 - pet.x) < 40) return enterIdle();

    settle();
    pet.facing = x1 < pet.x ? 'left' : 'right';
    const speed = skin.animations.walk?.moveSpeed ?? 60;
    setAnim('walk', { kind: 'walk', x1, speed });
    emit();
    after(moveDuration(pet), () => {
      pet.x = x1;
      pet.move = null;
      enterIdle();
    });
  }

  function enterSleep() {
    settle();
    pet.facing = skin.facing ?? 'left';
    setAnim('sleep');
    emit();
    clearTimer(); // 사용자가 건드릴 때까지 유지
  }

  function land() {
    pet.move = null;
    setAnim('drop');
    emit();
    after(animDuration('drop'), enterIdle);
  }

  return {
    pet,

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

    startDrag() {
      clearTimer();
      settle();
      lastActive = Date.now();
      pet.dragging = true;
      setAnim('drag');
      emit();
    },

    endDrag() {
      pet.dragging = false;
      lastActive = Date.now();
      const a = area(pet.display);
      if (!a) return enterIdle();
      pet.x = Math.min(Math.max(pet.x, a.left), a.right);
      if (pet.y < a.ground - 1) {
        setAnim('fall', { kind: 'fall', y1: a.ground, g: FALL_GRAVITY });
        emit();
        after(moveDuration(pet), () => {
          pet.y = a.ground;
          land();
        });
      } else {
        pet.y = a.ground;
        land();
      }
    },

    /** 모니터 구성이 바뀐 뒤 바닥에 다시 세운다. */
    relayout() {
      if (pet.dragging) return;
      const a = area(pet.display);
      if (a) {
        pet.x = Math.min(Math.max(pet.x, a.left), a.right);
        pet.y = a.ground;
      }
      enterIdle();
    },
  };
}
