// @ts-check
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { createPetEngine } from '../src/main/petEngine.js';
import { sleepSpotX } from '../src/main/sleepSpot.js';

const skin = {
  facing: 'left',
  anchor: { x: 80, y: 156 },
  scale: 1,
  hitbox: { x: 45, y: 24, w: 74, h: 132 },
  frameSize: { w: 160, h: 160 },
  animations: { walk: { frames: 8, fps: 10, moveSpeed: 60 }, drop: { frames: 4, fps: 10 }, done: { frames: 8, fps: 10 } },
};
const AREA = { left: 80, right: 1840 };
const area = () => ({ ...AREA, ground: 1000 });
const SEC = 1000;

test('sleepSpotX: 오른쪽 끝에서부터 빈 자리를 차례로 고른다', () => {
  const step = 90;
  assert.equal(sleepSpotX({ mode: 'right', area: AREA, step, taken: [] }), 1840);
  assert.equal(sleepSpotX({ mode: 'right', area: AREA, step, taken: [1840] }), 1750);
  assert.equal(sleepSpotX({ mode: 'right', area: AREA, step, taken: [1840, 1750] }), 1660);
  // 가운데 빈 자리는 건너뛰지 않고 가장 바깥쪽 빈 자리부터 채운다 (자고 있는 펫이 먼저 깨어 자리가 비었을 때)
  assert.equal(sleepSpotX({ mode: 'right', area: AREA, step, taken: [1750] }), 1840);
});

test('sleepSpotX: 왼쪽 끝, 가운데, 있던 자리에서 그대로', () => {
  const step = 90;
  assert.equal(sleepSpotX({ mode: 'left', area: AREA, step, taken: [] }), 80);
  assert.equal(sleepSpotX({ mode: 'left', area: AREA, step, taken: [80] }), 170);
  const c = (AREA.left + AREA.right) / 2;
  assert.equal(sleepSpotX({ mode: 'center', area: AREA, step, taken: [] }), c);
  assert.equal(sleepSpotX({ mode: 'center', area: AREA, step, taken: [c] }), c + step);
  assert.equal(sleepSpotX({ mode: 'center', area: AREA, step, taken: [c, c + step] }), c - step);
  assert.equal(sleepSpotX({ mode: 'here', area: AREA, step, taken: [] }), null);
  assert.equal(sleepSpotX({ mode: '엉터리', area: AREA, step, taken: [] }), null);
  assert.equal(sleepSpotX({ mode: 'right', area: null, step, taken: [] }), null);
});

test('sleepSpotX: 자리와 겹치는 위치에서 자는 펫(제자리에서 자던 펫 등)이 있으면 그 자리는 피한다', () => {
  const step = 90;
  assert.equal(sleepSpotX({ mode: 'right', area: AREA, step, taken: [1820] }), 1750, '1820은 1840과 20 차이라 겹치고 1750과는 70 차이라 괜찮다');
  assert.equal(sleepSpotX({ mode: 'right', area: AREA, step, taken: [1800] }), 1660, '1800은 1840과 1750 둘 다와 겹친다');
});

/** 가짜 시계/타이머와 고정 난수(0.1)로 엔진을 돌린다. */
function setup(/** @type {() => number | null} */ sleepSpot, sleepAfterMs = 60 * SEC) {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  mock.method(Math, 'random', () => 0.1);
  const engine = createPetEngine({ skin, area, emit: () => {}, sleepAfterMs, sleepSpot });
  engine.start(1, 960);
  const tick = (/** @type {number} */ ms) => {
    for (let t = 0; t < ms; t += 50) mock.timers.tick(Math.min(50, ms - t));
  };
  const cleanup = () => {
    engine.dispose();
    mock.timers.reset();
    mock.restoreAll();
  };
  return { engine, tick, cleanup };
}

test('잠잘 시간이 되면 잠자는 자리까지 걸어가서 거기서 잔다', () => {
  const { engine, tick, cleanup } = setup(() => 1800);
  try {
    tick(70 * SEC);
    assert.equal(engine.sleeping, false, '아직 가는 중');
    assert.equal(engine.pet.anim, 'walk');
    assert.equal(engine.sleepX, 1800, '가는 중에도 자리를 알려 다른 펫이 같은 자리를 피한다');
    tick(20 * SEC);
    assert.equal(engine.sleeping, true);
    assert.equal(engine.pet.x, 1800);
    assert.equal(engine.sleepX, 1800);
  } finally {
    cleanup();
  }
});

test('자리가 없으면(here) 걷지 않고 있던 자리에서 그대로 잔다', () => {
  const { engine, tick, cleanup } = setup(() => null);
  try {
    tick(70 * SEC);
    assert.equal(engine.sleeping, true);
    assert.equal(engine.sleepX, engine.pet.x, '자러 따로 걸어가지 않고 그 자리에서 잠든다');
    assert.ok(engine.pet.x < 1800, '오른쪽 끝 자리로 가지 않았다');
  } finally {
    cleanup();
  }
});

test('이미 자리 근처에 있으면 걷지 않고 바로 잔다', () => {
  /** @type {ReturnType<typeof createPetEngine> | null} */
  let eng = null;
  const { engine, tick, cleanup } = setup(() => (eng ? eng.pet.x + 10 : null)); // 자리가 지금 위치에서 10px 옆
  eng = engine;
  try {
    tick(70 * SEC);
    assert.equal(engine.sleeping, true);
    assert.equal(engine.sleepX, engine.pet.x);
  } finally {
    cleanup();
  }
});

test('자러 가는 도중 사용자가 건드리면 취소하고 깨어 있는다', () => {
  const { engine, tick, cleanup } = setup(() => 1800);
  try {
    tick(70 * SEC);
    assert.equal(engine.sleepX, 1800);
    engine.poke();
    assert.equal(engine.sleepX, null, '더는 자러 가는 중이 아니다');
    assert.notEqual(engine.pet.anim, 'sleep');
    tick(40 * SEC);
    assert.equal(engine.sleeping, false, '건드린 뒤 60초가 안 지났다');
  } finally {
    cleanup();
  }
});

test('자러 가는 도중 집어 올렸다 놓으면 자지 않는다', () => {
  const { engine, tick, cleanup } = setup(() => 1800);
  try {
    tick(70 * SEC);
    engine.startDrag();
    assert.equal(engine.sleepX, null);
    engine.endDrag();
    tick(30 * SEC);
    assert.equal(engine.sleeping, false);
  } finally {
    cleanup();
  }
});

test('깨어난 뒤에는 자리 예약이 사라진다', () => {
  const { engine, tick, cleanup } = setup(() => 1800);
  try {
    tick(100 * SEC);
    assert.equal(engine.sleepX, 1800);
    engine.poke();
    assert.equal(engine.sleepX, null);
    tick(10 * SEC); // 이리저리 걸어도 자러 가는 중으로 보이지 않는다
    assert.equal(engine.sleepX, null);
  } finally {
    cleanup();
  }
});

test('펫 둘이 같은 때 자러 가도 서로 다른 자리로 나란히 간다', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  mock.method(Math, 'random', () => 0.1);
  /** @type {ReturnType<typeof createPetEngine>[]} */
  const engines = [];
  const mk = (/** @type {number} */ i) => {
    const e = createPetEngine({
      skin,
      area,
      emit: () => {},
      sleepAfterMs: 60 * SEC,
      sleepSpot: () => sleepSpotX({ mode: 'right', area: AREA, step: 90, taken: engines.filter((o) => o !== e).map((o) => o.sleepX).filter((x) => x !== null) }),
    });
    engines.push(e);
    e.start(1, 300 + i * 40);
    return e;
  };
  try {
    const a = mk(0);
    const b = mk(1);
    for (let t = 0; t < 100 * SEC; t += 50) mock.timers.tick(50);
    assert.equal(a.sleeping && b.sleeping, true);
    assert.deepEqual([a.pet.x, b.pet.x].sort((x, y) => y - x), [1840, 1750]);
  } finally {
    for (const e of engines) e.dispose();
    mock.timers.reset();
    mock.restoreAll();
  }
});
