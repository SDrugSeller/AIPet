// @ts-check
// 펫의 행동 상태머신 (idle / walk / sleep / drag / fall / drop / 창 위로 jump 후 sit).
// 위치와 애니메이션 상태는 여기서만 바꾸고, 바뀔 때마다 emit()으로 모든 창에 알린다.
import { DOOR_CLOSE_MS, DOOR_OPEN_MS, FALL_GRAVITY, moveDuration, positionAt } from '../shared/motion.js';
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

// --- 다른 모니터로 이동: 이쪽 문으로 들어가서 저쪽 문으로 나온다 (모니터 배치는 몰라도 된다) ---
/** 들어가는 문은 펫 몸에서 이만큼(px) 떨어진 곳에 연다 */
const DOOR_GAP = 36;
/** 문으로 들어갈 때 펫이 사라지는 시간, 나올 때 나타나는 시간 */
const DOOR_FADE_MS = 250;
/** 나오는 문의 높이: 작업 영역 바닥에서 위로 이 비율(0~1)만큼 올라간 곳. 문에서 나온 펫은 거기서 바닥으로 뛰어내린다 */
const DOOR_HEIGHT_RATIO = 0.45;
/** 나오는 문이 열려 있는 시간(나타난 뒤) */
const DOOR_EMERGE_MS = 600;
/** 문 크기: 몸 높이에 대한 비율, 높이 대비 너비 */
const DOOR_BODY_RATIO = 1.15;
const DOOR_ASPECT = 0.55;

/**
 * @typedef {{ left: number, right: number, ground: number, top?: number }} Area
 *   펫이 서 있을 수 있는 영역: 발 x 범위와 바닥 y (작업표시줄 위). top: 작업 영역의 위쪽 y (없으면 바닥에서 600 위로 본다)
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
    /** 모니터 사이를 이동할 때의 투명도 변화와 문. 둘 다 시간으로 계산되어 렌더러가 매 프레임 그린다. */
    /** @type {import('../shared/motion.js').Fade | null} */
    fade: null,
    /** @type {import('../shared/motion.js').Door | null} */
    door: null,
  };

  const { bodyLeft, bodyRight, bodyUp } = bodyMetrics(skin);

  /** 다른 모니터로 가는 중인 이동. done: 도착했거나 취소됐을 때 부를 함수들 */
  /** @type {{ display: number, done: ((reason: 'arrived' | 'cancelled') => void)[] } | null} */
  let traveling = null;
  /** 지금은 출발할 수 없어서(창 위, 낙하 중) 바닥에 선 뒤로 미룬 이동 */
  /** @type {{ display: number, done: ((reason: 'arrived' | 'cancelled') => void)[] } | null} */
  let pendingTravel = null;

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

  const canVisitNow = () =>
    !visiting && !hold && !agentAnim && !perched && !pet.dragging && !traveling && !pendingTravel && (pet.anim === 'idle' || pet.anim === 'walk');

  /** @param {'done' | 'skipped' | 'cancelled'} reason */
  function endVisit(reason) {
    const v = visiting;
    visiting = null;
    v?.onEnd?.(reason);
  }

  /** 낙하/점프/착지 중에는 애니메이션을 바꾸지 않는다 (끝나면 enterIdle이 반영한다). */
  const busyMoving = () => pet.dragging || traveling !== null || pet.anim === 'fall' || pet.anim === 'drop' || pet.anim === 'jump';

  function enterIdle() {
    if (visiting) endVisit('cancelled'); // 방문 도중에 다른 동작이 끼어들었다
    if (pendingTravel && !pet.dragging) {
      // 미뤄 둔 모니터 이동: 창 위에 있으면 먼저 내려오고, 바닥에 서면 출발한다. 대화창이 열렸으면 포기한다.
      if (hold) cancelTravel();
      else if (perched) return fallToGround();
      else {
        const t = pendingTravel;
        pendingTravel = null;
        return beginTravel(t);
      }
    }
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

  // --- 다른 모니터로 이동 ---

  /** 이동이 끝났다(도착/취소): 기다리던 쪽에 알린다 @param {'arrived' | 'cancelled'} reason */
  function finishTravel(reason) {
    const t = traveling;
    traveling = null;
    for (const fn of t?.done ?? []) fn(reason);
  }

  /** 이동을 중단한다 (사용자가 집어 올렸거나 모니터 구성이 바뀌었다). 문과 투명도를 지우고 있는 자리에 둔다. */
  function cancelTravel() {
    if (pendingTravel) {
      const p = pendingTravel;
      pendingTravel = null;
      for (const fn of p.done) fn('cancelled');
    }
    if (!traveling) return;
    pet.fade = null;
    pet.door = null;
    finishTravel('cancelled');
  }

  /** 문의 크기: 몸 높이를 기준으로 한다 (스킨마다 몸 크기가 다르다) */
  function doorSize() {
    const h = Math.max(60, bodyUp * DOOR_BODY_RATIO);
    return { w: h * DOOR_ASPECT, h };
  }

  /** 이 모니터에서 문을 열고 들어간다: 문 쪽으로 걸어가 사라지고, 문이 닫히면 저쪽으로 넘어간다. @param {NonNullable<typeof traveling>} t */
  function beginTravel(t) {
    if (visiting) endVisit('cancelled');
    traveling = t;
    lastActive = Date.now();
    settle();
    const a = area(pet.display);
    if (!a) return arrive(); // 지금 모니터가 사라졌다: 들어가는 모션 없이 바로 건너간다
    const { w, h } = doorSize();
    // 화면 가운데 쪽에 문을 열어야 몸이 화면 밖으로 나가지 않는다
    const dir = pet.x < (a.left + a.right) / 2 ? 1 : -1;
    const reach = (dir > 0 ? bodyRight : bodyLeft) + DOOR_GAP;
    let x = clamp(pet.x + dir * reach, a.left, a.right);
    if (Math.abs(x - pet.x) < 24) x = clamp(pet.x - dir * reach, a.left, a.right);
    const speed = skin.animations.walk?.moveSpeed ?? 60;
    const walkMs = (Math.abs(x - pet.x) / speed) * 1000;
    pet.door = { x, y: pet.y, w, h, t0: Date.now(), dur: DOOR_OPEN_MS + walkMs + DOOR_FADE_MS + DOOR_CLOSE_MS };
    startWalk(x, () => {
      // 문 앞에 도착: 문 안으로 사라진다
      pet.fade = { t0: Date.now(), dur: DOOR_FADE_MS, from: 1, to: 0 };
      emit();
      after(DOOR_FADE_MS + DOOR_CLOSE_MS, arrive);
    });
  }

  /** 저쪽 모니터에 문을 열고 나와서 바닥으로 뛰어내린다. */
  function arrive() {
    const t = traveling;
    if (!t) return;
    const a = area(t.display);
    if (!a) {
      // 가려던 모니터가 그 사이 사라졌다: 있던 모니터에 다시 나타난다
      pet.fade = null;
      pet.door = null;
      finishTravel('cancelled');
      return enterIdle();
    }
    const { w, h } = doorSize();
    const top = a.top ?? a.ground - 600;
    // 문 높이는 작업 영역 높이의 일정 비율. 머리와 문이 화면 위로 나가지 않게 하고, 너무 낮은 화면에서는 바닥 가까이로 둔다.
    const headroom = skin.anchor.y * (skin.scale ?? 1);
    const want = a.ground - (a.ground - top) * DOOR_HEIGHT_RATIO;
    const y = Math.min(a.ground - 20, Math.max(want, top + Math.max(headroom, h) + 8));
    const x = a.left + (a.right - a.left) * rand(0.25, 0.75);

    pet.display = t.display;
    pet.x = x;
    pet.y = y;
    pet.move = null;
    pet.fade = { t0: Date.now(), dur: 1, from: 0, to: 0 }; // 문이 열릴 때까지는 보이지 않는다
    pet.door = { x, y, w, h, t0: Date.now(), dur: DOOR_OPEN_MS + DOOR_EMERGE_MS + DOOR_CLOSE_MS };
    pet.facing = skin.facing ?? 'left';
    setAnim('idle');
    emit();
    after(DOOR_OPEN_MS, () => {
      // 문이 열렸다: 나타나면서 바닥까지 뛰어내린다
      const g = area(pet.display);
      if (!g) return enterIdle();
      pet.fade = { t0: Date.now(), dur: DOOR_FADE_MS, from: 0, to: 1 };
      setAnim('fall', { kind: 'fall', y1: g.ground, g: FALL_GRAVITY });
      emit();
      after(moveDuration(pet), () => {
        pet.y = g.ground;
        pet.move = null;
        pet.fade = null;
        finishTravel('arrived'); // 착지하면 알린다: 말풍선은 여기서 뜬다
        land();
      });
    });
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

    /**
     * 다른 모니터로 건너간다: 이 모니터에 문을 열고 들어가, 저쪽 모니터의 문에서 나와 바닥으로 뛰어내린다.
     * 모니터의 배치와 상관없이 문으로 이어지므로 경계까지 걸어가지 않는다. 창 위에 있거나 낙하 중이면 바닥에 선 뒤에 출발한다.
     * 착지하거나(arrived) 도중에 취소되면(cancelled) onDone을 한 번 부른다.
     * 이미 그 모니터에 있거나, 갈 수 없거나(모니터가 없음, 드래그 중), 다른 모니터로 가는 중이면 false: 호출한 쪽이 그 자리에서 처리한다.
     * @param {number} display @param {(reason: 'arrived' | 'cancelled') => void} onDone
     */
    travel(display, onDone) {
      if (disposed) return false;
      const queue = traveling ?? pendingTravel;
      if (queue) {
        if (queue.display !== display) return false;
        queue.done.push(onDone); // 같은 곳으로 가는 중이면 함께 기다린다
        return true;
      }
      if (pet.dragging || display === pet.display || !area(display)) return false;
      const t = { display, done: [onDone] };
      if (perched || busyMoving()) {
        pendingTravel = t;
        if (perched) fallToGround();
        return true;
      }
      beginTravel(t);
      return true;
    },

    /** 다른 모니터로 가는 중인가 (테스트/디버그용) */
    get traveling() {
      return traveling !== null || pendingTravel !== null;
    },

    /** 처음 위치를 정하고 행동을 시작한다. */
    start(/** @type {number} */ display, /** @type {number} */ x) {
      pet.display = display;
      pet.x = x;
      pet.y = area(display)?.ground ?? 0;
      pet.fade = null;
      pet.door = null;
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
      cancelTravel();
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
      cancelTravel();
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
