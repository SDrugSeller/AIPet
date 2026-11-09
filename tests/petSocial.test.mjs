// @ts-check
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { createPetEngine } from '../src/main/petEngine.js';
import { createSocial, MIN_SLEEP_MS, PAIR_COOLDOWN_MS } from '../src/main/social.js';

const skin = {
  facing: 'left',
  anchor: { x: 80, y: 156 },
  scale: 1,
  hitbox: { x: 45, y: 24, w: 74, h: 132 }, // 몸 폭 = 왼쪽 35 + 오른쪽 39 = 74
  frameSize: { w: 160, h: 160 },
  animations: { walk: { frames: 8, fps: 10, moveSpeed: 60 }, drop: { frames: 4, fps: 10 }, done: { frames: 8, fps: 10 } },
};
const area = () => ({ left: 80, right: 1840, ground: 1000 });

/**
 * 가짜 시계/타이머와 고정 난수(0.1)로 펫 둘과 조정자를 만든다.
 * A는 오래 깨어 있고(10분), B는 1초만 가만히 있으면 잠든다.
 */
function setup({ display = [1, 1], enabled = () => true } = {}) {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  mock.method(Math, 'random', () => 0.1);
  const mk = (/** @type {number} */ sleepAfterMs) => {
    const engine = createPetEngine({ skin, area, emit: () => {}, sleepAfterMs });
    return engine;
  };
  const a = mk(10 * 60_000);
  const b = mk(1_000);
  a.start(display[0], 500);
  b.start(display[1], 900);
  const logs = /** @type {string[]} */ ([]);
  const social = createSocial({
    getPets: () => [{ id: 'A', engine: a }, { id: 'B', engine: b }],
    enabled,
    log: (m) => logs.push(m),
    now: () => Date.now(),
    rand: () => 0.1,
  });
  const tick = (/** @type {number} */ ms) => {
    for (let t = 0; t < ms; t += 50) mock.timers.tick(Math.min(50, ms - t));
  };
  const cleanup = () => {
    a.dispose();
    b.dispose();
    mock.timers.reset();
    mock.restoreAll();
  };
  /** 조건이 될 때까지 50ms씩 진행한다 (최대 maxMs) */
  const until = (/** @type {() => boolean} */ cond, maxMs = 30_000) => {
    for (let t = 0; t < maxMs && !cond(); t += 50) mock.timers.tick(50);
    assert.ok(cond(), '시간 안에 조건이 되지 않음');
  };
  /** B가 잠들고 충분히 지날 때까지 진행한다 */
  const untilSleptEnough = () => {
    tick(4000);
    assert.equal(b.pet.anim, 'sleep');
    tick(MIN_SLEEP_MS);
  };
  return { a, b, social, logs, tick, until, cleanup, untilSleptEnough };
}

test('깨어 있는 펫이 자는 펫 옆으로 가서 깨우면, 자던 펫이 깨어난다', () => {
  const { a, b, social, logs, tick, until, cleanup, untilSleptEnough } = setup();
  try {
    untilSleptEnough();
    assert.equal(a.sleeping, false);
    assert.equal(social.tick(), true);
    assert.equal(social.busy, true);
    assert.match(logs[0], /A.*B.*깨우러 감/);

    until(() => a.pet.anim === 'nudge'); // 걸어가서 도착
    assert.equal(a.pet.anim, 'nudge');
    assert.equal(Math.abs(a.pet.x - b.pet.x), 74, '몸 하나 폭만큼 떨어져 선다');
    assert.equal(a.pet.facing, a.pet.x < b.pet.x ? 'right' : 'left', '자는 펫 쪽을 본다');
    assert.equal(b.pet.anim, 'sleep', '아직 손이 닿기 전');

    tick(1200); // 손이 닿는다
    assert.equal(b.pet.anim, 'wake');
    assert.equal(b.pet.facing, b.pet.x < a.pet.x ? 'right' : 'left', '깨운 펫 쪽을 본다');
    assert.match(logs.at(-1) ?? '', /B.*깨움/);

    tick(1200); // 마무리
    assert.notEqual(a.pet.anim, 'nudge');
    assert.notEqual(b.pet.anim, 'wake');
    assert.equal(b.sleeping, false);
    assert.equal(social.busy, false);
  } finally {
    cleanup();
  }
});

test('가는 도중 사용자가 집어 들면 방문이 취소된다', () => {
  const { a, b, social, logs, tick, cleanup, untilSleptEnough } = setup();
  try {
    untilSleptEnough();
    assert.equal(social.tick(), true);
    tick(1000);
    a.startDrag();
    assert.equal(social.busy, false);
    assert.match(logs.at(-1) ?? '', /취소/);
    tick(20_000);
    assert.equal(b.pet.anim, 'sleep', '자던 펫은 그대로 잔다');
  } finally {
    cleanup();
  }
});

test('가는 도중 자던 펫을 사용자가 깨우면, 도착해도 깨우는 동작을 하지 않는다', () => {
  const { a, b, social, logs, tick, cleanup, untilSleptEnough } = setup();
  try {
    untilSleptEnough();
    assert.equal(social.tick(), true);
    tick(1000);
    b.poke(); // 사용자가 클릭해서 깨움
    b.setHold(true); // 대화창을 열어 둔 상태라 다시 잠들지 않는다
    assert.equal(b.sleeping, false);
    tick(12_000);
    assert.notEqual(a.pet.anim, 'nudge');
    assert.equal(social.busy, false);
    assert.match(logs.at(-1) ?? '', /생략/);
  } finally {
    cleanup();
  }
});

test('가는 도중 사용자가 방문하는 펫을 클릭해도 취소된다', () => {
  const { a, social, tick, cleanup, untilSleptEnough } = setup();
  try {
    untilSleptEnough();
    assert.equal(social.tick(), true);
    tick(1000);
    a.poke();
    assert.equal(social.busy, false);
    assert.equal(a.pet.anim, 'idle');
  } finally {
    cleanup();
  }
});

test('같은 쌍은 쿨다운이 지나야 다시 간다 (깨웠다 재웠다 반복 방지)', () => {
  const { social, tick, cleanup, untilSleptEnough } = setup();
  try {
    untilSleptEnough();
    assert.equal(social.tick(), true);
    tick(16_000); // 방문이 끝난다
    assert.equal(social.busy, false);
    tick(4000 + MIN_SLEEP_MS); // 깬 펫이 다시 잠들고 충분히 지났다
    assert.equal(social.tick(), false, '쿨다운 안이라 가지 않는다');
    tick(PAIR_COOLDOWN_MS);
    assert.equal(social.tick(), true, '쿨다운이 지나면 다시 간다');
  } finally {
    cleanup();
  }
});

test('방문하는 동안에는 다른 방문을 시작하지 않는다', () => {
  const { social, cleanup, untilSleptEnough } = setup();
  try {
    untilSleptEnough();
    assert.equal(social.tick(), true);
    assert.equal(social.tick(), false);
  } finally {
    cleanup();
  }
});

test('꺼져 있거나, 모니터가 다르거나, 방금 잠든 펫이면 가지 않는다', () => {
  let on = false;
  const off = setup({ enabled: () => on });
  try {
    off.untilSleptEnough();
    assert.equal(off.social.tick(), false, '꺼져 있음');
    on = true;
    assert.equal(off.social.tick(), true);
  } finally {
    off.cleanup();
  }

  const other = setup({ display: [1, 2] });
  try {
    other.untilSleptEnough();
    assert.equal(other.social.tick(), false, '다른 모니터');
  } finally {
    other.cleanup();
  }

  const fresh = setup();
  try {
    fresh.tick(4000);
    assert.equal(fresh.b.pet.anim, 'sleep');
    assert.equal(fresh.social.tick(), false, '막 잠든 펫은 바로 깨우지 않는다');
  } finally {
    fresh.cleanup();
  }
});

test('대화창이 열려 있거나(hold) 에이전트가 일하는 펫은 깨우러 가지 않는다', () => {
  const { a, social, cleanup, untilSleptEnough } = setup();
  try {
    untilSleptEnough();
    a.setHold(true);
    assert.equal(a.canVisit, false);
    assert.equal(social.tick(), false);
    a.setHold(false);
    a.setAgentAnim('work');
    assert.equal(a.canVisit, false);
    assert.equal(social.tick(), false);
    a.setAgentAnim(null);
    assert.equal(social.tick(), true);
  } finally {
    cleanup();
  }
});

test('자고 있지 않은 펫은 wakeUp이 false이고 아무것도 바꾸지 않는다', () => {
  const { a, cleanup } = setup();
  try {
    const before = a.pet.anim;
    assert.equal(a.wakeUp(0), false);
    assert.equal(a.pet.anim, before);
  } finally {
    cleanup();
  }
});
