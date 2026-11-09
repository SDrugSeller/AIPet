// @ts-check
import assert from 'node:assert/strict';
import test from 'node:test';
import { createAgentHost } from '../src/main/agent/agentHost.js';

/** 정해진 이벤트를 내보내는 가짜 어댑터 @param {string} id @param {any[]} events @param {{ok:boolean,reason?:string}} [detect] */
function fakeAdapter(id, events, detect = { ok: true }) {
  return {
    id,
    label: id,
    detect: async () => detect,
    send: async function* () {
      for (const e of events) yield e;
    },
    respondPermission() {},
    abort() {},
    reset() {},
  };
}

function setup(adapters, preferred) {
  /** @type {any[]} */ const anims = [];
  /** @type {any[]} */ const sent = [];
  const engine = {
    poke() {},
    setHold() {},
    setAgentAnim: (/** @type {string | null} */ name, /** @type {any} */ opts) => anims.push([name, opts?.once ? 'once' : '']),
  };
  const host = createAgentHost({ adapters, engine, broadcast: (c, p) => sent.push([c, p]), preferred });
  return { host, anims, sent };
}

test('이벤트가 펫 모션에 매핑된다: think → talk → done(once)', async () => {
  const { host, anims } = setup([
    fakeAdapter('a', [
      { type: 'status', state: 'thinking' },
      { type: 'text', delta: '안' },
      { type: 'text', delta: '녕' },
      { type: 'done' },
    ]),
  ]);
  await host.refresh();
  await host.send('hi');
  assert.deepEqual(anims, [['think', ''], ['talk', ''], ['done', 'once']]);
  assert.equal(host.snapshot().log.at(-1)?.text, '안녕');
  assert.equal(host.snapshot().busy, false);
});

test('working 상태와 error가 매핑된다', async () => {
  const { host, anims } = setup([
    fakeAdapter('a', [{ type: 'status', state: 'working' }, { type: 'error', message: '실패' }]),
  ]);
  await host.refresh();
  await host.send('hi');
  assert.deepEqual(anims, [['think', ''], ['work', ''], ['error', 'once']]);
  assert.deepEqual(host.snapshot().log.at(-1), { role: 'error', text: '실패' });
});

test('사용 가능한 첫 백엔드를 자동 선택하고, 선호 백엔드가 있으면 우선한다', async () => {
  const adapters = [fakeAdapter('a', [], { ok: false, reason: 'x' }), fakeAdapter('b', []), fakeAdapter('c', [])];
  const first = setup(adapters);
  await first.host.refresh();
  assert.equal(first.host.snapshot().backend?.id, 'b');

  const pref = setup(adapters, 'c');
  await pref.host.refresh();
  assert.equal(pref.host.snapshot().backend?.id, 'c');
});

test('사용 가능한 백엔드가 없으면 이유가 담긴 오류를 보여 준다', async () => {
  const { host, sent } = setup([fakeAdapter('a', [], { ok: false, reason: '설치되지 않음' })]);
  await host.refresh();
  await host.send('hi');
  const err = sent.find(([c, p]) => c === 'agent:event' && p.type === 'error');
  assert.match(err[1].message, /설치되지 않음/);
});

test('이미 응답 중이면 새 메시지는 무시한다', async () => {
  let release = () => {};
  const slow = {
    ...fakeAdapter('a', []),
    send: async function* () {
      await new Promise((r) => (release = () => r(undefined)));
      yield { type: 'done' };
    },
  };
  const { host } = setup([slow]);
  await host.refresh();
  const first = host.send('one');
  await host.send('two'); // busy라 바로 반환
  release();
  await first;
  assert.deepEqual(host.snapshot().log.map((e) => e.text), ['one']);
});

test('끝 이벤트 없이 스트림이 끝나면(중단) 모션을 일반 행동으로 되돌린다', async () => {
  const { host, anims } = setup([fakeAdapter('a', [{ type: 'status', state: 'thinking' }])]);
  await host.refresh();
  await host.send('hi');
  assert.deepEqual(anims.at(-1), [null, '']);
});

test('어댑터가 알린 세션 끊김은 대화 기록(session)에 남고 대화창에도 전달된다', async () => {
  const { host, sent } = setup([
    fakeAdapter('a', [{ type: 'session', text: '이전 대화 세션이 만료됐어요' }, { type: 'text', delta: '안녕' }, { type: 'done' }]),
  ]);
  await host.refresh();
  await host.send('hi');
  const log = host.snapshot().log;
  assert.deepEqual(log.map((e) => e.role), ['user', 'session', 'assistant']);
  assert.equal(log[1].text, '이전 대화 세션이 만료됐어요');
  assert.ok(sent.some(([c, p]) => c === 'agent:event' && p.type === 'session'));
});

test('대화가 오간 뒤 AI 연결을 바꾸면 새 대화로 시작한다는 표시를 남긴다 (대화가 없으면 남기지 않는다)', async () => {
  const { host, sent } = setup([fakeAdapter('a', [{ type: 'text', delta: '응' }, { type: 'done' }]), fakeAdapter('b', [{ type: 'done' }])]);
  await host.refresh();
  host.select('b'); // 아직 대화가 없다
  assert.equal(host.snapshot().log.length, 0);
  host.select('a');
  await host.send('hi');
  host.select('b');
  const last = host.snapshot().log.at(-1);
  assert.equal(last?.role, 'session');
  assert.match(last?.text ?? '', /새 대화/);
  assert.ok(sent.some(([c, p]) => c === 'agent:event' && p.type === 'session' && /새 대화/.test(p.text)));
});

test('새 대화: 어댑터 맥락을 비우고, 이전 대화는 그대로 두고 구분선만 남긴다', async () => {
  let resets = 0;
  const a = { ...fakeAdapter('a', [{ type: 'text', delta: '응' }, { type: 'done' }]), reset: () => resets++ };
  const { host, sent } = setup([a]);
  await host.refresh();
  await host.send('안녕');
  const before = host.snapshot().log.map((e) => ({ ...e }));

  assert.equal(host.newSession(), true);
  assert.equal(resets, 1);
  const log = host.snapshot().log;
  assert.deepEqual(log.slice(0, before.length), before); // 이전 대화는 보존된다
  assert.equal(log.at(-1)?.role, 'session');
  assert.match(log.at(-1)?.text ?? '', /새 대화/);
  assert.ok(sent.some(([c, p]) => c === 'agent:event' && p.type === 'session' && /새 대화/.test(p.text))); // 대화창에도 전달
});

test('새 대화: 이어 온 대화가 없으면(처음이거나 방금 눌렀으면) 아무것도 하지 않는다', async () => {
  let resets = 0;
  const a = { ...fakeAdapter('a', [{ type: 'text', delta: '응' }, { type: 'done' }]), reset: () => resets++ };
  const { host } = setup([a]);
  await host.refresh();
  assert.equal(host.newSession(), false); // 아직 대화가 없다
  await host.send('안녕');
  assert.equal(host.newSession(), true);
  assert.equal(host.newSession(), false); // 방금 눌렀다: 구분선이 연달아 쌓이지 않는다
  assert.equal(resets, 1);
  assert.equal(host.snapshot().log.filter((e) => e.role === 'session').length, 1);
  await host.send('다시 말할게');
  assert.equal(host.newSession(), true); // 새 대화가 오간 뒤에는 다시 가능
  assert.equal(resets, 2);
});

test('새 대화: 응답 중에는 시작하지 않는다 (비활성화와 같은 규칙)', async () => {
  let resets = 0;
  /** @type {() => void} */
  let release = () => {};
  const gate = new Promise((r) => (release = () => r(undefined)));
  const a = {
    ...fakeAdapter('a', []),
    send: async function* () {
      yield { type: 'status', state: 'working' };
      await gate;
      yield { type: 'done' };
    },
    reset: () => resets++,
  };
  const { host } = setup([a]);
  await host.refresh();
  const done = host.send('오래 걸리는 질문');
  await new Promise((r) => setTimeout(r, 5));
  assert.equal(host.snapshot().busy, true);
  assert.equal(host.newSession(), false);
  assert.equal(resets, 0);
  release();
  await done;
  assert.equal(host.newSession(), true); // 끝난 뒤에는 가능
});
