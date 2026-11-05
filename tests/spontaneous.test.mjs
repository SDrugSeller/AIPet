// @ts-check
import assert from 'node:assert/strict';
import test from 'node:test';
import { AWAY_AFTER_SEC, createNotifier } from '../src/main/spontaneous.js';

const MIN = 60_000;

/** 시계와 입력을 마음대로 조작할 수 있는 테스트 환경 */
function setup(settings = {}, quiet = {}) {
  const s = {
    enabled: true,
    breakReminder: true,
    breakAfterMin: 60,
    breakMessage: '쉬어요',
    cooldownMin: 30,
    notifyDone: true,
    reminders: /** @type {{ time: string, text: string, enabled: boolean }[]} */ ([]),
    ...settings,
  };
  const q = { dnd: false, fullscreen: false, chatActive: false, hidden: false, ...quiet };
  const env = { t: new Date('2026-11-05T09:00:00').getTime(), idle: 0 };
  /** @type {{ text: string, kind: string }[]} */
  const shown = [];
  const n = createNotifier({
    getSettings: () => s,
    getQuiet: () => q,
    idleSeconds: () => env.idle,
    show: (m) => shown.push(m),
    now: () => env.t,
  });
  const advance = (/** @type {number} */ minutes) => {
    env.t += minutes * MIN;
    n.tick();
  };
  return { n, s, q, env, shown, advance };
}

test('쉬지 않고 breakAfterMin 넘게 쓰면 쉬라고 한 번 말한다', () => {
  const { n, shown, advance } = setup();
  n.tick(); // 사용 시작
  advance(59);
  assert.equal(shown.length, 0);
  advance(2);
  assert.deepEqual(shown, [{ text: '쉬어요', kind: 'break' }]);
});

test('쉬라는 말은 옵트인이다 (꺼져 있으면 말하지 않는다)', () => {
  const { n, shown, advance } = setup({ breakReminder: false });
  n.tick();
  advance(200);
  assert.equal(shown.length, 0);
});

test('자리를 비우면(입력이 없으면) 쉰 것으로 보고 다시 센다', () => {
  const { n, env, shown, advance } = setup();
  n.tick();
  advance(50);
  env.idle = AWAY_AFTER_SEC + 1; // 자리 비움
  advance(5);
  env.idle = 0; // 돌아옴
  advance(1);
  advance(50); // 돌아온 뒤 51분
  assert.equal(shown.length, 0);
  advance(15);
  assert.equal(shown.length, 1);
});

test('쿨다운: 다시 말하기까지 최소 간격을 지킨다', () => {
  const { n, shown, advance } = setup({ breakAfterMin: 10, cooldownMin: 45 });
  n.tick();
  advance(11);
  assert.equal(shown.length, 1);
  advance(11); // 10분 더 썼지만 쿨다운(45분) 전
  assert.equal(shown.length, 1);
  advance(30); // 첫 말(11분) 뒤 52분: 아직 쿨다운(45분) 중
  assert.equal(shown.length, 1);
  advance(5); // 57분: 쿨다운이 지났다
  assert.equal(shown.length, 2);
});

test('방해 금지, 전체화면, 숨김 상태에서는 말하지 않는다', () => {
  for (const quiet of [{ dnd: true }, { fullscreen: true }, { hidden: true }]) {
    const { n, shown, advance } = setup({}, quiet);
    n.tick();
    advance(120);
    assert.equal(shown.length, 0, JSON.stringify(quiet));
  }
});

test('대화 중에는 먼저 말하지 않는다', () => {
  const { n, shown, advance } = setup({}, { chatActive: true });
  n.tick();
  advance(120);
  assert.equal(shown.length, 0);
});

test('조용해야 해서 못 한 말은 조건이 풀리면 한다 (쿨다운은 그대로 적용)', () => {
  const { n, q, shown, advance } = setup({ breakAfterMin: 10 });
  q.fullscreen = true;
  n.tick();
  advance(30);
  assert.equal(shown.length, 0);
  q.fullscreen = false;
  advance(1);
  assert.equal(shown.length, 1);
});

test('정해진 시각 알림: 그 시각에 한 번만 알린다', () => {
  const { n, env, shown, advance } = setup({ breakReminder: false, reminders: [{ time: '09:30', text: '회의!', enabled: true }] });
  advance(29);
  assert.equal(shown.length, 0);
  advance(1);
  assert.deepEqual(shown, [{ text: '회의!', kind: 'reminder' }]);
  env.t += 30_000;
  n.tick(); // 같은 분 안에 다시 확인해도
  advance(1);
  assert.equal(shown.length, 1);
});

test('정해진 시각 알림은 쿨다운과 상관없이 알리지만 방해 금지는 지킨다', () => {
  const a = setup({ breakReminder: false, cooldownMin: 600, reminders: [{ time: '09:05', text: 'A', enabled: true }, { time: '09:06', text: 'B', enabled: true }] });
  a.advance(5);
  a.advance(1);
  assert.deepEqual(a.shown.map((x) => x.text), ['A', 'B']);

  const b = setup({ breakReminder: false, reminders: [{ time: '09:05', text: 'A', enabled: true }] }, { dnd: true });
  b.advance(5);
  assert.equal(b.shown.length, 0);
});

test('조용해서 못 전한 시각 알림은 풀리면 전하고, 너무 오래되면 버린다', () => {
  const late = setup({ breakReminder: false, reminders: [{ time: '09:05', text: 'A', enabled: true }] }, { fullscreen: true });
  late.advance(5);
  late.q.fullscreen = false;
  late.advance(10);
  assert.deepEqual(late.shown.map((x) => x.text), ['A']);

  const stale = setup({ breakReminder: false, reminders: [{ time: '09:05', text: 'A', enabled: true }] }, { fullscreen: true });
  stale.advance(5);
  stale.advance(40); // 30분 넘게 전하지 못했다
  stale.q.fullscreen = false;
  stale.advance(1);
  assert.equal(stale.shown.length, 0);
});

test('꺼 둔 알림은 울리지 않는다', () => {
  const { shown, advance } = setup({ breakReminder: false, reminders: [{ time: '09:05', text: 'A', enabled: false }] });
  advance(5);
  assert.equal(shown.length, 0);
});

test('작업 완료 알림: 대화창이 닫혀 있을 때만, 방해 금지/전체화면을 지킨다', () => {
  const ok = setup();
  assert.equal(ok.n.onTaskDone({ ok: true, text: '파일을\n만들었어요' }), true);
  assert.deepEqual(ok.shown, [{ text: '파일을 만들었어요', kind: 'done' }]);

  assert.equal(setup({}, { dnd: true }).n.onTaskDone({ ok: true, text: 'x' }), false);
  assert.equal(setup({}, { fullscreen: true }).n.onTaskDone({ ok: true, text: 'x' }), false);
  assert.equal(setup({}, { chatActive: true }).n.onTaskDone({ ok: true, text: 'x' }), false);
  assert.equal(setup({ notifyDone: false }).n.onTaskDone({ ok: true, text: 'x' }), false);
});

test('작업 완료 알림은 쿨다운과 무관하고, 긴 내용은 줄이고, 실패는 그렇게 알린다', () => {
  const { n, shown } = setup({ cooldownMin: 600 });
  n.onTaskDone({ ok: true, text: 'a'.repeat(300) });
  n.onTaskDone({ ok: false, text: '연결이 끊어졌어요' });
  assert.equal(shown.length, 2);
  assert.ok(shown[0].text.length <= 141 && shown[0].text.endsWith('…'));
  assert.equal(shown[1].text, '문제가 생겼어요: 연결이 끊어졌어요');
});

test('전체 스위치를 끄면 어떤 말도 하지 않는다 (쉬라는 말, 시각 알림, 작업 완료)', () => {
  const off = setup(
    { enabled: false, breakAfterMin: 10, reminders: [{ time: '09:05', text: 'A', enabled: true }] },
    {},
  );
  off.n.tick();
  off.advance(120);
  assert.equal(off.shown.length, 0);
  assert.equal(off.n.onTaskDone({ ok: true, text: '끝' }), false);
  assert.equal(off.shown.length, 0);
});

test('전체 스위치를 켜는 순간 묵은 알림이 한꺼번에 나오지 않는다', () => {
  const t = setup({ enabled: false, breakAfterMin: 10, reminders: [{ time: '09:05', text: 'A', enabled: true }] });
  t.n.tick();
  t.advance(60); // 끈 채로 한 시간이 지났다
  t.s.enabled = true;
  t.advance(1);
  assert.equal(t.shown.length, 0); // 쉬는 시간 세기는 지금부터 새로, 한참 지난 시각 알림은 버린다
});
