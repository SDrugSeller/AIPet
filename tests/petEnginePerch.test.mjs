// @ts-check
import assert from 'node:assert/strict';
import test, { mock } from 'node:test';
import { createPetEngine } from '../src/main/petEngine.js';

const skin = {
  facing: 'left',
  anchor: { x: 80, y: 156 },
  scale: 1,
  hitbox: { x: 45, y: 24, w: 74, h: 132 },
  frameSize: { w: 160, h: 160 },
  animations: { walk: { frames: 8, fps: 10, moveSpeed: 60 }, drop: { frames: 4, fps: 10 }, done: { frames: 8, fps: 10 } },
};
const GROUND = 1000;
const area = () => ({ left: 80, right: 1840, ground: GROUND });
const perch = (over = {}) => ({ id: 'w1', left: 500, right: 1300, top: 400, display: 1, ...over });

/** 가짜 타이머/시계와 고정된 난수(항상 0.1)로 엔진을 돌린다. 0.1이면 "창에 올라가기"가 선택된다. */
function setup() {
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  mock.method(Math, 'random', () => 0.1);
  /** @type {string[]} */
  const anims = [];
  const engine = createPetEngine({ skin, area, emit: () => anims.push(engine.pet.anim), sleepAfterMs: 10 * 60_000 });
  engine.start(1, 960);
  const cleanup = () => {
    mock.timers.reset();
    mock.restoreAll();
  };
  // 한 번에 크게 진행하면 도중에 새로 예약되는 타이머를 놓치므로, 잘게 나눠 진행한다.
  const tick = (/** @type {number} */ ms) => {
    for (let t = 0; t < ms; t += 50) mock.timers.tick(Math.min(50, ms - t));
  };
  return { engine, anims, cleanup, tick };
}

test('올라갈 창이 있으면 뛰어올라 창 윗변에 선다', () => {
  const { engine, tick, cleanup } = setup();
  try {
    engine.setTarget(perch());
    tick(3500); // 쉬는 시간이 끝나고 다음 행동을 고른다
    assert.equal(engine.pet.anim, 'jump');
    assert.equal(engine.pet.move?.kind, 'jump');
    assert.equal(/** @type {any} */ (engine.pet.move).y1, 400);

    tick(1000); // 점프가 끝나 착지
    assert.equal(engine.perchedOn, 'w1');
    assert.equal(engine.pet.y, 400);
    assert.equal(engine.pet.x, 960);

    tick(500); // 착지 동작이 끝나면 걸터앉은 자세
    assert.equal(engine.pet.anim, 'sit');
  } finally {
    cleanup();
  }
});

test('창 밖에서 시작하면 창 아래까지 걸어간 뒤 뛴다', () => {
  const { engine, tick, cleanup } = setup();
  try {
    engine.setTarget(perch({ left: 1400, right: 2000 })); // 펫은 x=960, 창은 오른쪽에 있다
    tick(3500);
    assert.equal(engine.pet.anim, 'walk');
    assert.equal(engine.pet.facing, 'right');
    tick(20_000); // 도착까지 걷는다
    assert.ok(['jump', 'drop', 'sit'].includes(engine.pet.anim), engine.pet.anim);
    tick(2000);
    assert.equal(engine.perchedOn, 'w1');
    // 창의 가장자리 안쪽(몸이 들어가는 범위)에 선다
    assert.ok(engine.pet.x >= 1400 + 35 && engine.pet.x <= 1840, String(engine.pet.x));
  } finally {
    cleanup();
  }
});

test('올라서 있는 창이 움직이면 같은 자리에 머문 채 따라간다', () => {
  const { engine, tick, cleanup } = setup();
  try {
    engine.setTarget(perch());
    tick(3500);
    tick(1500);
    assert.equal(engine.perchedOn, 'w1');
    const offset = engine.pet.x - 500;

    engine.setTarget(perch({ left: 700, right: 1500, top: 350 })); // 창을 끌었다
    assert.equal(engine.pet.x, 700 + offset);
    assert.equal(engine.pet.y, 350);
    assert.equal(engine.perchedOn, 'w1');
  } finally {
    cleanup();
  }
});

test('창이 작아져 펫이 밖으로 나가게 되면 가장자리 안으로 밀어 넣는다', () => {
  const { engine, tick, cleanup } = setup();
  try {
    engine.setTarget(perch());
    tick(5000);
    engine.setTarget(perch({ right: 700 })); // 창이 오른쪽에서 줄어들었다
    assert.ok(engine.pet.x <= 700 - 39, String(engine.pet.x));
  } finally {
    cleanup();
  }
});

test('활성 창이 바뀌거나 사라지면 바닥으로 떨어진다', () => {
  const { engine, tick, cleanup } = setup();
  try {
    engine.setTarget(perch());
    tick(5000);
    assert.equal(engine.perchedOn, 'w1');

    engine.setTarget(null); // 창을 닫았다 / 다른 창으로 전환
    assert.equal(engine.perchedOn, null);
    assert.equal(engine.pet.anim, 'fall');
    tick(2000);
    assert.equal(engine.pet.y, GROUND);
    assert.notEqual(engine.pet.anim, 'fall');
  } finally {
    cleanup();
  }
});

test('다른 창으로 바뀌어도 내려온다 (id가 다르면 다른 창)', () => {
  const { engine, tick, cleanup } = setup();
  try {
    engine.setTarget(perch());
    tick(5000);
    engine.setTarget(perch({ id: 'w2', left: 100, right: 600 }));
    assert.equal(engine.pet.anim, 'fall');
  } finally {
    cleanup();
  }
});

test('사용자가 집어 올리면 창에서 내려오고, 놓으면 바닥에 떨어진다', () => {
  const { engine, tick, cleanup } = setup();
  try {
    engine.setTarget(perch());
    tick(5000);
    engine.startDrag();
    assert.equal(engine.perchedOn, null);
    assert.equal(engine.pet.anim, 'drag');
    engine.setTarget(null); // 드래그 중 창이 사라져도 아무 일 없다
    assert.equal(engine.pet.anim, 'drag');
    engine.endDrag();
    tick(2000);
    assert.equal(engine.pet.y, GROUND);
  } finally {
    cleanup();
  }
});

test('뛰어오르는 사이 창이 사라지면 착지하지 않고 바닥으로 떨어진다', () => {
  const { engine, tick, cleanup } = setup();
  try {
    engine.setTarget(perch());
    tick(3500);
    assert.equal(engine.pet.anim, 'jump');
    engine.setTarget(null);
    tick(1000);
    assert.equal(engine.perchedOn, null);
    tick(3000);
    assert.equal(engine.pet.y, GROUND);
  } finally {
    cleanup();
  }
});

test('다른 모니터의 창에는 올라가지 않는다', () => {
  const { engine, tick, cleanup } = setup();
  try {
    engine.setTarget(perch({ display: 2 }));
    tick(3500);
    assert.notEqual(engine.pet.anim, 'jump');
    assert.equal(engine.perchedOn, null);
  } finally {
    cleanup();
  }
});

test('내려온 직후에는 한동안 다시 올라가지 않는다', () => {
  const { engine, tick, cleanup } = setup();
  try {
    engine.setTarget(perch());
    tick(5000);
    engine.setTarget(null);
    tick(3000); // 바닥에 내려옴
    engine.setTarget(perch());
    tick(8000); // 다음 행동을 골라도 쿨다운(45초) 중이라 올라가지 않는다
    assert.equal(engine.perchedOn, null);
    tick(60_000);
    tick(8000);
    assert.equal(engine.perchedOn, 'w1');
  } finally {
    cleanup();
  }
});
