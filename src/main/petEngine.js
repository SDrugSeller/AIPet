// @ts-check
// 펫의 행동 상태머신 (idle / walk / sleep / drag / fall / drop / 창 위로 jump 후 sit).
// 위치와 애니메이션 상태는 여기서만 바꾸고, 바뀔 때마다 emit()으로 모든 창에 알린다.
import { FALL_GRAVITY, moveDuration, positionAt } from '../shared/motion.js';
import { wakeAwakeMs } from '../shared/sleep.js';
import { bodyMetrics } from './perch.js';

/** @param {number} a @param {number} b */
const rand = (a, b) => a + Math.random() * (b - a);
/** @param {number} v @param {number} lo @param {number} hi */
const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

/** 창에서 내려온 뒤, 다시 올라가기까지 최소로 쉬는 시간 */
const PERCH_COOLDOWN_MS = 45_000;
/** 쉬는 동안 다음 행동을 고를 때 창에 올라가기로 할 확률 */
const PERCH_CHANCE = 0.4;
/** 자는 펫을 깨우러 가서 도착한 뒤 깨우는 손짓(nudge)을 시작해 실제로 닿기까지, 그리고 닿은 뒤 마무리까지 */
const NUDGE_HIT_MS = 1200;
const NUDGE_REST_MS = 1100;
/** 깨어나는 모션(wake) 길이 */
const WAKE_MS = 1100;

/**
 * @typedef {{ left: number, right: number, ground: number }} Area
 *   펫이 서 있을 수 있는 영역: 발 x 범위와 바닥 y (작업표시줄 위)
 *
 * @param {{
 *   skin: any,
 *   area: (displayId: number) => Area | null,
 *   emit: () => void,
 *   sleepAfterMs: number | (() => number),
 *   sleepSpot?: () => number | null,
 * }} opts
 */
export function createPetEngine({ skin, area, emit: emitRaw, sleepAfterMs: sleepAfterOpt, sleepSpot }) {
  /** 마지막으로 건드린 뒤 잠들기까지의 시간(ms). 설정이 바뀌면 바로 반영되도록 매번 읽는다. 잠들지 않으면 Infinity */
  const sleepAfterMs = () => (typeof sleepAfterOpt === 'function' ? sleepAfterOpt() : sleepAfterOpt);
  /** 펫이 사라진 뒤(연결 삭제 등)에는 타이머가 남아 있어도 아무것도 하지 않는다. */
  let disposed = false;
  const emit = () => {
    if (!disposed) emitRaw();
  };
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

  // --- 자는 펫 깨우러 가기 (펫끼리 어울리기) ---
  /** 지금 진행 중인 방문. 다른 동작이 끼어들면 'cancelled'로 끝난다. */
  /** @type {{ onEnd?: (reason: 'done' | 'skipped' | 'cancelled') => void } | null} */
  let visiting = null;

  const canVisitNow = () => !visiting && !hold && !agentAnim && !perched && !pet.dragging && (pet.anim === 'idle' || pet.anim === 'walk');

  /** @param {'done' | 'skipped' | 'cancelled'} reason */
  function endVisit(reason) {
    const v = visiting;
    visiting = null;
    v?.onEnd?.(reason);
  }

  /** 낙하/점프/착지 중에는 애니메이션을 바꾸지 않는다 (끝나면 enterIdle이 반영한다). */
  const busyMoving = () => pet.dragging || pet.anim === 'fall' || pet.anim === 'drop' || pet.anim === 'jump';

  function enterIdle() {
    if (visiting) endVisit('cancelled'); // 방문 도중에 다른 동작이 끼어들었다
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
          lastActive = Date.now(); // 완료/오류 모션이 끝난 때부터 다시 센다
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
    if (Date.now() - lastActive > sleepAfterMs()) return goSleep();
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

  /** 자러 가는 자리(발 x). 자리로 걸어가는 중에만 의미가 있다. */
  /** @type {number | null} */
  let sleepGoal = null;

  /** 잠잘 시간이 됐다: 정해진 잠자는 자리가 있으면 거기까지 걸어가서 잔다. 없으면 있던 자리에서 잔다. */
  function goSleep() {
    const spot = area(pet.display) ? (sleepSpot?.() ?? null) : null;
    if (spot === null || Math.abs(spot - pet.x) < 24) return enterSleep();
    sleepGoal = spot;
    startWalk(spot, () => {
      // 걸어가는 사이 사용자가 건드렸으면 자지 않는다
      if (Date.now() - lastActive > sleepAfterMs()) enterSleep();
      else enterIdle();
    });
  }

  /** 지금 자러 자리로 걸어가는 중인가 */
  const headingToBed = () => sleepGoal !== null && pet.anim === 'walk' && pet.move?.kind === 'walk' && pet.move.x1 === sleepGoal;

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

    /** 이 펫을 정리한다: 예약된 동작을 모두 취소하고 더는 상태를 알리지 않는다. */
    dispose() {
      disposed = true;
      if (visiting) endVisit('cancelled');
      clearTimer();
    },

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
      if (visiting) {
        endVisit('cancelled');
        enterIdle();
      } else if (pet.anim === 'sleep' || headingToBed()) {
        enterIdle();
      }
    },

    /** 자고 있거나 자러 가는 곳(발 x). 아니면 null. 다른 펫이 같은 자리를 피하는 데 쓴다. */
    get sleepX() {
      if (pet.anim === 'sleep' && !pet.dragging) return pet.x;
      return headingToBed() ? sleepGoal : null;
    },

    /** 자고 있는가 */
    get sleeping() {
      return pet.anim === 'sleep' && !pet.dragging;
    },

    /** 다른 펫을 깨우러 갈 만큼 한가한가: 바닥에서 가만히 있거나 걷는 중이고 대화·에이전트·드래그와 무관할 때 */
    get canVisit() {
      return canVisitNow();
    },

    /** 이 펫이 잠든 지 얼마나 됐는지(ms). 자고 있지 않으면 0 */
    sleptFor() {
      return pet.anim === 'sleep' ? Date.now() - pet.t0 : 0;
    },

    /**
     * 자고 있는 펫(발 위치 toward) 옆으로 걸어가 깨운다. 갈 수 없으면 false.
     * 도착했을 때 shouldNudge()가 false면(그 사이 상대가 깼다 등) 아무것도 하지 않고 끝난다.
     * 손이 닿는 순간 onNudge()를 부르고, 끝나면 onEnd(reason)을 부른다. 도중에 사용자가 건드리면 'cancelled'.
     * @param {{ toward: number, shouldNudge: () => boolean, onNudge: () => void, onEnd?: (reason: 'done' | 'skipped' | 'cancelled') => void }} opts
     */
    visit({ toward, shouldNudge, onNudge, onEnd }) {
      if (!canVisitNow()) return false;
      const a = area(pet.display);
      if (!a) return false;
      const gap = bodyLeft + bodyRight; // 몸 하나 폭 떨어져 선다
      const side = pet.x < toward ? -1 : 1;
      let x1 = clamp(toward + side * gap, a.left, a.right);
      if (Math.abs(x1 - toward) < gap * 0.7) x1 = clamp(toward - side * gap, a.left, a.right); // 화면 끝이라 반대쪽으로
      if (Math.abs(x1 - toward) < gap * 0.7) return false;
      visiting = { onEnd };
      const me = visiting;
      startWalk(x1, () => {
        if (visiting !== me) return;
        if (!shouldNudge()) {
          endVisit('skipped');
          return enterIdle();
        }
        pet.facing = toward < pet.x ? 'left' : 'right';
        setAnim('nudge');
        emit();
        after(NUDGE_HIT_MS, () => {
          if (visiting !== me) return;
          onNudge();
          after(NUDGE_REST_MS, () => {
            endVisit('done');
            enterIdle();
          });
        });
      });
      return true;
    },

    /**
     * 다른 펫이 깨웠다: 그쪽(발 위치 fromX)을 보며 깨어난다. 자고 있지 않았으면 false.
     * @param {number} fromX
     */
    wakeUp(fromX) {
      if (pet.anim !== 'sleep' || pet.dragging) return false;
      // 사용자가 건드렸을 때(잠들기까지 전체)의 2/3만 깨어 있다가 다시 잔다. 깨우고 깨우고가 끝없이 이어지지 않게 한다.
      const full = sleepAfterMs();
      lastActive = Number.isFinite(full) ? Date.now() - full + wakeAwakeMs(full) : Date.now();
      settle();
      pet.facing = fromX < pet.x ? 'left' : 'right';
      setAnim('wake');
      emit();
      after(WAKE_MS, enterIdle);
      return true;
    },

    /** 대화창이 열려 있는 동안 제자리에 머문다. */
    setHold(/** @type {boolean} */ value) {
      if (hold === value) return;
      hold = value;
      if (!value) lastActive = Date.now(); // 대화창을 닫은 때부터 다시 센다 (오래 대화하다 닫자마자 잠들지 않게)
      if (!busyMoving()) enterIdle();
    },

    /**
     * 에이전트 상태 애니메이션을 재생한다. null이면 일반 행동으로 복귀.
     * once=true면 한 번 재생한 뒤 자동으로 복귀한다 (done, error).
     */
    setAgentAnim(/** @type {string | null} */ name, /** @type {{ once?: boolean }} */ { once = false } = {}) {
      if (name === agentAnim && once === agentOnce) return;
      if (name === null) lastActive = Date.now(); // 작업이 끝난 때부터 다시 센다
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
      if (visiting) endVisit('cancelled');
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
