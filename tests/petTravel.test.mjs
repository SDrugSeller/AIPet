// @ts-check
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { alphaAt, doorFrameAt, doorOpenness } from '../src/shared/motion.js';
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

test('문 프레임: 열리는 그림 → 활짝 → 닫히는 그림 (닫히는 그림이 따로 있을 때)', () => {
  const door = { x: 0, y: 0, w: 30, h: 60, t0: 1000, dur: 2000 };
  const spec = { frames: 10, openFrames: 6 };
  assert.equal(doorFrameAt(door, 900, spec), null, '아직 안 열렸다');
  assert.equal(doorFrameAt(door, 1000, spec), null);
  assert.equal(doorFrameAt(door, 1010, spec), 0, '열리기 시작');
  assert.equal(doorFrameAt(door, 1299, spec), 5, '다 열리기 직전 마지막 열림 프레임');
  assert.equal(doorFrameAt(door, 2000, spec), 5, '열려 있는 동안은 활짝 열린 프레임');
  assert.equal(doorFrameAt(door, 2705, spec), 6, '닫히기 시작: 닫히는 그림의 첫 장');
  assert.equal(doorFrameAt(door, 2999, spec), 9, '닫히는 그림의 마지막 장');
  assert.equal(doorFrameAt(door, 3000, spec), null, '닫혔다');
});

test('문 프레임: 닫히는 그림이 없으면 열리는 그림을 거꾸로 재생한다', () => {
  const door = { x: 0, y: 0, w: 30, h: 60, t0: 0, dur: 2000 };
  const spec = { frames: 5 };
  assert.equal(doorFrameAt(door, 1000, spec), 4);
  assert.equal(doorFrameAt(door, 1705, spec), 4, '닫히기 시작은 활짝 열린 장에서');
  assert.equal(doorFrameAt(door, 1999, spec), 0, '끝에서는 닫힌 장');
  const seen = [];
  for (let t = 1700; t < 2000; t += 20) seen.push(/** @type {number} */ (doorFrameAt(door, t, spec)));
  assert.deepEqual(seen, [...seen].sort((a, b) => b - a), '닫히는 동안 프레임 번호가 줄어든다');
});

test('가끔 스스로 다른 모니터로 건너간다 (쉬는 시간 2분 뒤부터, 갈 곳이 있을 때만)', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  mock.method(Math, 'random', () => 0.1);
  const engine = createPetEngine({ skin, area: (d) => AREAS[d] ?? null, emit: () => {}, sleepAfterMs: 60 * 60_000, hopTargets: () => [1, 2] });
  try {
    engine.start(1, 960);
    for (let t = 0; t < 110_000; t += 50) mock.timers.tick(50);
    assert.equal(engine.pet.display, 1, '2분 전에는 건너가지 않는다');
    for (let t = 0; t < 25_000; t += 50) mock.timers.tick(50);
    assert.equal(engine.pet.display, 2, '그 뒤 쉬는 사이 문을 열고 건너갔다');
    assert.equal(engine.pet.y, 900, '저쪽 바닥에 착지');
  } finally {
    engine.dispose();
    mock.timers.reset();
    mock.restoreAll();
  }
});

test('갈 모니터를 주지 않거나 비어 있으면 스스로 건너가지 않는다', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  mock.method(Math, 'random', () => 0.1);
  const a = createPetEngine({ skin, area: (d) => AREAS[d] ?? null, emit: () => {}, sleepAfterMs: 60 * 60_000 });
  const b = createPetEngine({ skin, area: (d) => AREAS[d] ?? null, emit: () => {}, sleepAfterMs: 60 * 60_000, hopTargets: () => [] });
  try {
    a.start(1, 960);
    b.start(1, 960);
    for (let t = 0; t < 300_000; t += 50) mock.timers.tick(50);
    assert.equal(a.pet.display, 1);
    assert.equal(b.pet.display, 1);
  } finally {
    a.dispose();
    b.dispose();
    mock.timers.reset();
    mock.restoreAll();
  }
});

test('다른 모니터의 자는 펫을 깨우러: 문으로 건너가 자는 펫 가까이에서 나와 걸어가 깨운다', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  mock.method(Math, 'random', () => 0.1);
  const mk = (/** @type {number} */ sleepAfterMs) => createPetEngine({ skin, area: (d) => AREAS[d] ?? null, emit: () => {}, sleepAfterMs });
  const a = mk(10 * 60_000);
  const b = mk(1_000);
  try {
    a.start(1, 500);
    b.start(2, 2500);
    for (let t = 0; t < 4000; t += 50) mock.timers.tick(50);
    assert.equal(b.sleeping, true);
    /** @type {string[]} */
    const events = [];
    const started = a.visit({
      toward: b.pet.x,
      display: 2,
      shouldNudge: () => b.sleeping && b.pet.display === a.pet.display,
      onNudge: () => events.push(b.wakeUp(a.pet.x) ? 'nudge' : 'nudge-miss'),
      onEnd: (r) => events.push(`end:${r}`),
    });
    assert.equal(started, true);
    assert.equal(a.canVisit, false);
    for (let t = 0; t < 20_000 && !events.includes('end:done'); t += 50) mock.timers.tick(50);
    assert.deepEqual(events, ['nudge', 'end:done']);
    assert.equal(a.pet.display, 2, '건너가서 깨웠다');
    assert.ok(Math.abs(a.pet.x - b.pet.x) < 120, '자는 펫 바로 옆에서');
    assert.equal(b.sleeping, false, '깨어났다');
  } finally {
    a.dispose();
    b.dispose();
    mock.timers.reset();
    mock.restoreAll();
  }
});

test('깨우러 건너가는 도중 집어 올리면 방문이 취소된다', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  mock.method(Math, 'random', () => 0.1);
  const a = createPetEngine({ skin, area: (d) => AREAS[d] ?? null, emit: () => {}, sleepAfterMs: 10 * 60_000 });
  try {
    a.start(1, 500);
    /** @type {string[]} */
    const ends = [];
    assert.equal(a.visit({ toward: 2500, display: 2, shouldNudge: () => true, onNudge: () => {}, onEnd: (r) => ends.push(r) }), true);
    for (let t = 0; t < 1500; t += 50) mock.timers.tick(50);
    a.startDrag();
    assert.deepEqual(ends, ['cancelled']);
    for (let t = 0; t < 10_000; t += 50) mock.timers.tick(50);
    assert.deepEqual(ends, ['cancelled'], '한 번만 끝난다');
    assert.equal(a.pet.display, 1);
  } finally {
    a.dispose();
    mock.timers.reset();
    mock.restoreAll();
  }
});

test('깨우러 건너가는 도중 사용자가 건드리면(poke) 이동도 접고 깨어 있는다', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  mock.method(Math, 'random', () => 0.1);
  const a = createPetEngine({ skin, area: (d) => AREAS[d] ?? null, emit: () => {}, sleepAfterMs: 10 * 60_000 });
  try {
    a.start(1, 500);
    /** @type {string[]} */
    const ends = [];
    a.visit({ toward: 2500, display: 2, shouldNudge: () => true, onNudge: () => {}, onEnd: (r) => ends.push(r) });
    for (let t = 0; t < 1500; t += 50) mock.timers.tick(50);
    a.poke();
    assert.deepEqual(ends, ['cancelled']);
    assert.equal(a.traveling, false);
    assert.equal(a.pet.fade, null);
    assert.equal(a.pet.door, null);
    for (let t = 0; t < 10_000; t += 50) mock.timers.tick(50);
    assert.equal(a.pet.display, 1, '건너가지 않는다');
  } finally {
    a.dispose();
    mock.timers.reset();
    mock.restoreAll();
  }
});

test('스킨에 문 그림이 있으면 그 크기(바닥에서 위쪽 끝까지)로 도착 문의 높이를 정한다', () => {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  mock.method(Math, 'random', () => 0.1);
  const withDoor = { ...skin, door: { skin: 'default', sheet: 'door.png', frames: 10, openFrames: 6, frameSize: { w: 128, h: 128 }, anchor: { x: 64, y: 124 }, scale: 2, pixelArt: false, display: { w: 256, h: 256 } } };
  const engine = createPetEngine({ skin: withDoor, area: (d) => AREAS[d] ?? null, emit: () => {}, sleepAfterMs: 60 * 60_000 });
  const tall = { ...withDoor, door: { ...withDoor.door, scale: 4 } };
  const e2 = createPetEngine({ skin: tall, area: (d) => AREAS[d] ?? null, emit: () => {}, sleepAfterMs: 60 * 60_000 });
  try {
    engine.start(1, 960);
    e2.start(1, 960);
    engine.travel(2, () => {});
    e2.travel(2, () => {});
    for (let t = 0; t < 1850; t += 50) mock.timers.tick(50);
    assert.equal(engine.pet.display, 2);
    assert.equal(Math.round(engine.pet.y), 540, '작업 영역 100~900의 45% 높이');
    assert.ok(e2.pet.y >= 100 + 496 + 8 - 1, '문 높이 496이 화면 위로 나가지 않게 아래로 민다');
  } finally {
    engine.dispose();
    e2.dispose();
    mock.timers.reset();
    mock.restoreAll();
  }
});
