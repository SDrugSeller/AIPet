// @ts-check
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { alphaAt, doorOpenness } from '../src/shared/motion.js';
import { createPetEngine } from '../src/main/petEngine.js';

const skin = {
  facing: 'left',
  anchor: { x: 80, y: 156 },
  scale: 1,
  hitbox: { x: 45, y: 24, w: 74, h: 132 },
  frameSize: { w: 160, h: 160 },
  animations: { walk: { frames: 8, fps: 10, moveSpeed: 60 }, drop: { frames: 4, fps: 10 }, done: { frames: 8, fps: 10 } },
};

/** 모니터 1은 왼쪽, 2는 오른쪽 (배치는 엔진이 몰라도 된다) */
const AREAS = /** @type {Record<number, { left: number, right: number, ground: number, top: number } | null>} */ ({
  1: { left: 80, right: 1840, ground: 1000, top: 0 },
  2: { left: 2000, right: 3600, ground: 900, top: 100 },
});

/** 가짜 시계/타이머와 고정 난수(0.1)로 엔진을 돌린다. 펫은 모니터 1의 가운데에서 시작한다. */
function setup() {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  mock.method(Math, 'random', () => 0.1);
  const engine = createPetEngine({ skin, area: (d) => AREAS[d] ?? null, emit: () => {}, sleepAfterMs: 60 * 60_000 });
  engine.start(1, 960);
  let elapsed = 0;
  /** 시작부터 ms가 될 때까지 시간을 흘린다 */
  const until = (/** @type {number} */ ms) => {
    while (elapsed < ms) {
      mock.timers.tick(50);
      elapsed += 50;
    }
  };
  const cleanup = () => {
    engine.dispose();
    mock.timers.reset();
    mock.restoreAll();
    AREAS[2] = { left: 2000, right: 3600, ground: 900, top: 100 };
  };
  return { engine, until, cleanup, now: () => Date.now() };
}

test('다른 모니터로: 문을 열고 들어가 사라지고, 저쪽 문에서 나와 바닥으로 뛰어내린다', () => {
  const { engine, until, cleanup, now } = setup();
  try {
    /** @type {string[]} */
    const done = [];
    assert.equal(engine.travel(2, (r) => done.push(r)), true);
    assert.equal(engine.traveling, true);
    assert.equal(engine.pet.display, 1);
    assert.equal(engine.pet.door?.y, 1000, '들어가는 문은 지금 서 있는 바닥에 연다');
    assert.equal(engine.pet.anim, 'walk', '문 쪽으로 걸어간다');

    until(1500); // 문 앞에 도착해 사라지는 중
    assert.equal(engine.pet.display, 1);
    assert.equal(engine.pet.fade?.to, 0);
    assert.deepEqual(done, []);

    until(1850); // 문이 닫히고 건너갔다: 저쪽 문에서 아직 안 보이는 채로 문이 열린다
    assert.equal(engine.pet.display, 2);
    assert.equal(alphaAt(engine.pet, now()), 0);
    const door = /** @type {NonNullable<typeof engine.pet.door>} */ (engine.pet.door);
    assert.equal(door.y, engine.pet.y);
    // 작업 영역(100~900)에서 바닥으로부터 45% 높이
    assert.equal(Math.round(door.y), Math.round(900 - 800 * 0.45));
    assert.ok(engine.pet.x >= 2000 + 1600 * 0.25 && engine.pet.x <= 2000 + 1600 * 0.75, '저쪽 모니터의 가운데 쪽에 문이 생긴다');
    assert.deepEqual(done, []);

    until(2200); // 문이 열려 나타나며 뛰어내리는 중
    assert.equal(engine.pet.anim, 'fall');
    assert.ok(alphaAt(engine.pet, now()) > 0);

    until(3100); // 착지
    assert.deepEqual(done, ['arrived']);
    assert.equal(engine.pet.y, 900, '저쪽 모니터의 바닥');
    assert.equal(engine.pet.fade, null);
    assert.equal(engine.traveling, false);

    until(4000); // 착지 모션이 끝나고 평소로
    assert.notEqual(engine.pet.anim, 'fall');
    assert.equal(engine.pet.display, 2);
  } finally {
    cleanup();
  }
});

test('이미 그 모니터에 있거나 갈 수 없는 곳이면 false: 부른 쪽이 그 자리에서 처리한다', () => {
  const { engine, cleanup } = setup();
  try {
    assert.equal(engine.travel(1, () => {}), false, '같은 모니터');
    assert.equal(engine.travel(99, () => {}), false, '없는 모니터');
    assert.equal(engine.traveling, false);
    engine.startDrag();
    assert.equal(engine.travel(2, () => {}), false, '드래그 중');
  } finally {
    cleanup();
  }
});

test('이동 도중 집어 올리면 이동을 취소하고 한 번만 알린다', () => {
  const { engine, until, cleanup, now } = setup();
  try {
    /** @type {string[]} */
    const done = [];
    engine.travel(2, (r) => done.push(r));
    until(1500);
    engine.startDrag();
    assert.deepEqual(done, ['cancelled']);
    assert.equal(engine.traveling, false);
    assert.equal(engine.pet.fade, null);
    assert.equal(engine.pet.door, null);
    assert.equal(alphaAt(engine.pet, now()), 1, '다시 보인다');
    until(6000);
    assert.deepEqual(done, ['cancelled'], '취소된 뒤 타이머가 남아 건너가지 않는다');
    assert.equal(engine.pet.display, 1);
  } finally {
    cleanup();
  }
});

test('같은 모니터로 가는 중에 다시 부르면 함께 기다리고, 다른 모니터로는 false', () => {
  const { engine, until, cleanup } = setup();
  try {
    /** @type {string[]} */
    const done = [];
    assert.equal(engine.travel(2, () => done.push('a')), true);
    assert.equal(engine.travel(2, () => done.push('b')), true);
    assert.equal(engine.travel(1, () => done.push('c')), false);
    until(3100);
    assert.deepEqual(done, ['a', 'b']);
  } finally {
    cleanup();
  }
});

test('떨어지는 중이면 바닥에 선 뒤에 출발한다', () => {
  const { engine, until, cleanup } = setup();
  try {
    engine.startDrag();
    engine.pet.y = 500; // 공중에서 놓는다
    engine.endDrag();
    assert.equal(engine.pet.anim, 'fall');
    /** @type {string[]} */
    const done = [];
    assert.equal(engine.travel(2, (r) => done.push(r)), true);
    assert.equal(engine.pet.door, null, '아직 출발하지 않았다');
    assert.equal(engine.traveling, true);
    until(1000); // 착지하고 나면 문을 연다
    assert.ok(engine.pet.door, '착지한 뒤 문을 열었다');
    assert.equal(engine.pet.display, 1);
    until(6000);
    assert.deepEqual(done, ['arrived']);
    assert.equal(engine.pet.display, 2);
  } finally {
    cleanup();
  }
});

test('이동하는 동안에는 다른 펫을 깨우러 가지 않는다', () => {
  const { engine, cleanup } = setup();
  try {
    assert.equal(engine.canVisit, true);
    engine.travel(2, () => {});
    assert.equal(engine.canVisit, false);
  } finally {
    cleanup();
  }
});

test('가려던 모니터가 사라졌으면 있던 모니터에 다시 나타난다', () => {
  const { engine, until, cleanup, now } = setup();
  try {
    /** @type {string[]} */
    const done = [];
    engine.travel(2, (r) => done.push(r));
    AREAS[2] = null; // 문으로 들어간 사이 모니터를 뽑았다
    until(2000);
    assert.deepEqual(done, ['cancelled']);
    assert.equal(engine.pet.display, 1);
    assert.equal(alphaAt(engine.pet, now()), 1);
    assert.equal(engine.pet.door, null);
  } finally {
    cleanup();
  }
});

test('문 열림 정도: 열리고, 열려 있다가, 닫힌다', () => {
  const door = { x: 0, y: 0, w: 30, h: 60, t0: 1000, dur: 2000 };
  assert.equal(doorOpenness(door, 900), 0, '아직 안 열렸다');
  assert.equal(doorOpenness(door, 1000), 0);
  assert.ok(doorOpenness(door, 1150) > 0 && doorOpenness(door, 1150) < 1, '열리는 중');
  assert.equal(doorOpenness(door, 2000), 1, '활짝');
  assert.ok(doorOpenness(door, 2850) > 0 && doorOpenness(door, 2850) < 1, '닫히는 중');
  assert.equal(doorOpenness(door, 3000), 0, '닫혔다');
});

test('투명도: fade가 없으면 보이고, 있으면 from에서 to로 바뀌어 to로 머문다', () => {
  assert.equal(alphaAt({ fade: null }, 5000), 1);
  const fade = { t0: 1000, dur: 200, from: 1, to: 0 };
  assert.equal(alphaAt({ fade }, 1000), 1);
  assert.equal(alphaAt({ fade }, 1100), 0.5);
  assert.equal(alphaAt({ fade }, 1200), 0);
  assert.equal(alphaAt({ fade }, 9999), 0);
  assert.equal(alphaAt({ fade: { t0: 0, dur: 1, from: 0, to: 0 } }, 5), 0, '숨겨 둔 채로');
});
