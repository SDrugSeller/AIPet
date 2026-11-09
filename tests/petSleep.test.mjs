// @ts-check
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { createPetEngine } from '../src/main/petEngine.js';
import { WAKE_AWAKE_RATIO, wakeAwakeMs } from '../src/shared/sleep.js';

const skin = {
  facing: 'left',
  anchor: { x: 80, y: 156 },
  scale: 1,
  hitbox: { x: 45, y: 24, w: 74, h: 132 },
  frameSize: { w: 160, h: 160 },
  animations: { walk: { frames: 8, fps: 10, moveSpeed: 60 }, drop: { frames: 4, fps: 10 }, done: { frames: 8, fps: 10 } },
};
const area = () => ({ left: 80, right: 1840, ground: 1000 });

/** 가짜 시계/타이머와 고정 난수(0.1: 다음 행동 고르는 간격 3.5초)로 엔진을 돌린다. @param {number | (() => number)} sleepAfterMs */
function setup(sleepAfterMs) {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  mock.method(Math, 'random', () => 0.1);
  const engine = createPetEngine({ skin, area, emit: () => {}, sleepAfterMs });
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
const SEC = 1000;

test('마지막으로 건드린 뒤 설정한 시간이 지나면 잠든다 (다음 행동을 고르는 시점에)', () => {
  const { engine, tick, cleanup } = setup(60 * SEC);
  try {
    tick(59 * SEC);
    assert.equal(engine.sleeping, false);
    tick(8 * SEC);
    assert.equal(engine.sleeping, true);
  } finally {
    cleanup();
  }
});

test('설정이 바뀌면 다음 판단부터 새 시간을 쓴다', () => {
  let sec = 600;
  const { engine, tick, cleanup } = setup(() => sec * SEC);
  try {
    tick(30 * SEC);
    assert.equal(engine.sleeping, false);
    sec = 20; // 사용자가 설정에서 줄였다
    tick(4 * SEC);
    assert.equal(engine.sleeping, true);
  } finally {
    cleanup();
  }
});

test('잠들지 않기(Infinity)면 아무리 지나도 잠들지 않는다', () => {
  const { engine, tick, cleanup } = setup(Infinity);
  try {
    tick(30 * 60 * SEC);
    assert.equal(engine.sleeping, false);
  } finally {
    cleanup();
  }
});

test('오래 대화하다 대화창을 닫아도 닫은 때부터 다시 센다 (닫자마자 잠들지 않는다)', () => {
  const { engine, tick, cleanup } = setup(60 * SEC);
  try {
    engine.poke();
    engine.setHold(true); // 대화창 열림
    tick(5 * 60 * SEC); // 5분 동안 대화
    assert.equal(engine.sleeping, false);
    engine.setHold(false); // 닫음
    tick(30 * SEC);
    assert.equal(engine.sleeping, false, '닫은 지 30초: 아직 아님');
    tick(40 * SEC);
    assert.equal(engine.sleeping, true, '닫은 지 60초가 넘으면 잠든다');
  } finally {
    cleanup();
  }
});

test('에이전트가 오래 일하다 끝나도 끝난 때부터 다시 센다', () => {
  const { engine, tick, cleanup } = setup(60 * SEC);
  try {
    engine.setAgentAnim('work');
    tick(5 * 60 * SEC);
    assert.equal(engine.sleeping, false);
    engine.setAgentAnim('done', { once: true }); // 완료 모션
    tick(5 * SEC);
    assert.equal(engine.sleeping, false, '완료 직후에는 잠들지 않는다');
    tick(50 * SEC);
    assert.equal(engine.sleeping, false);
    tick(20 * SEC);
    assert.equal(engine.sleeping, true);
  } finally {
    cleanup();
  }
});

test('다른 펫이 깨운 펫은 설정한 시간의 2/3만 깨어 있다가 다시 잠든다', () => {
  const { engine, tick, cleanup } = setup(60 * SEC);
  try {
    tick(70 * SEC);
    assert.equal(engine.sleeping, true);
    assert.equal(engine.wakeUp(0), true);
    tick(2 * SEC);
    assert.equal(engine.sleeping, false);
    tick(34 * SEC); // 깨운 지 36초: 40초(=60초의 2/3)가 안 됐다
    assert.equal(engine.sleeping, false);
    tick(12 * SEC); // 깨운 지 48초: 40초를 넘겼고 다음 판단 시점이 지났다
    assert.equal(engine.sleeping, true);
  } finally {
    cleanup();
  }
});

test('2/3 규칙은 설정값을 따라 바뀌고, 잠들지 않으면 무한이다', () => {
  assert.equal(WAKE_AWAKE_RATIO, 2 / 3);
  assert.equal(wakeAwakeMs(60_000), 40_000);
  assert.equal(wakeAwakeMs(300_000), 200_000);
  assert.equal(wakeAwakeMs(Infinity), Infinity);
});
