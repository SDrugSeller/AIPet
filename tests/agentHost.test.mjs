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
