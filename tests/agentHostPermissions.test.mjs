// @ts-check
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createAgentHost } from '../src/main/agent/agentHost.js';

const workDir = path.join(os.tmpdir(), 'aipet-perm-work');

/**
 * 도구를 한 번 요청하고, 사용자 응답을 받으면 끝나는 가짜 어댑터.
 * @param {{ name: string, input: any }} tool
 */
function toolAdapter(tool) {
  /** @type {[string, boolean, string | undefined][]} */
  const responses = [];
  // 응답이 await보다 먼저 와도 놓치지 않도록 미리 만들어 둔다
  /** @type {() => void} */
  let release = () => {};
  const answered = new Promise((r) => (release = () => r(undefined)));
  return {
    responses,
    adapter: {
      id: 'a',
      label: 'A',
      detect: async () => ({ ok: true }),
      send: async function* () {
        yield { type: 'status', state: 'working' };
        yield { type: 'tool_request', id: 'req-1', name: tool.name, input: tool.input };
        await answered;
        yield { type: 'text', delta: '끝' };
        yield { type: 'done' };
      },
      respondPermission(/** @type {string} */ id, /** @type {boolean} */ allow, /** @type {string | undefined} */ message) {
        responses.push([id, allow, message]);
        release();
      },
      abort() {
        release();
      },
      reset() {},
    },
  };
}

function setup(/** @type {any} */ adapter, policy = { autoAllowRead: true, workDir }) {
  /** @type {any[]} */ const anims = [];
  /** @type {any[]} */ const sent = [];
  /** @type {any[]} */ const opens = [];
  let beeps = 0;
  const engine = {
    poke() {},
    setHold() {},
    setAgentAnim: (/** @type {string | null} */ name) => anims.push(name),
  };
  const host = createAgentHost({
    adapters: [adapter],
    engine,
    broadcast: (c, p) => sent.push([c, p]),
    onOpenChange: (open, opts) => opens.push([open, opts.focus]),
    getPolicy: () => policy,
    notify: () => beeps++,
  });
  return { host, anims, sent, opens, beeps: () => beeps };
}

/** 이벤트 루프를 한 번 돌려 비동기 작업이 진행되게 한다 */
const tick = () => new Promise((r) => setTimeout(r, 5));

test('쓰기 도구는 사용자에게 묻고, 허용하면 어댑터에 전달된다', async () => {
  const { adapter, responses } = toolAdapter({ name: 'Write', input: { file_path: path.join(workDir, 'a.txt'), content: 'hi' } });
  const t = setup(adapter);
  await t.host.refresh();
  const done = t.host.send('파일 만들어줘');
  await tick();

  // 승인 카드가 뜨고, 펫은 attention, 말풍선은 포커스를 훔치지 않고 열린다
  const req = t.sent.find(([c]) => c === 'perm:request');
  assert.equal(req[1].id, 'req-1');
  assert.equal(req[1].title, '파일 쓰기');
  assert.equal(t.anims.at(-1), 'attention');
  assert.deepEqual(t.opens, [[true, false]]);
  assert.equal(t.beeps(), 1);
  assert.equal(t.host.snapshot().pending.length, 1);
  assert.equal(responses.length, 0); // 아직 응답하지 않았다

  t.host.respondPermission('req-1', true);
  await done;

  assert.deepEqual(responses, [['req-1', true, undefined]]);
  assert.ok(t.sent.some(([c, p]) => c === 'perm:resolved' && p.id === 'req-1' && p.allow === true));
  assert.equal(t.host.snapshot().pending.length, 0);
  assert.ok(t.anims.includes('work')); // 허용 후 다시 작업 중 모션
});

test('거부하면 어댑터가 거부 사유와 함께 응답받는다', async () => {
  const { adapter, responses } = toolAdapter({ name: 'Bash', input: { command: 'dir' } });
  const t = setup(adapter);
  await t.host.refresh();
  const done = t.host.send('명령 실행해줘');
  await tick();
  t.host.respondPermission('req-1', false);
  await done;
  assert.equal(responses[0][1], false);
  assert.match(responses[0][2] ?? '', /거부/);
});

test('작업 폴더 밖 경로는 묻지 않고 바로 거부한다', async () => {
  const { adapter, responses } = toolAdapter({ name: 'Write', input: { file_path: path.join(os.tmpdir(), 'elsewhere', 'x.txt') } });
  const t = setup(adapter);
  await t.host.refresh();
  await t.host.send('x'); // 어댑터가 바로 응답받아 끝난다
  assert.equal(responses[0][1], false);
  assert.match(responses[0][2] ?? '', /작업 폴더/);
  assert.equal(t.sent.some(([c]) => c === 'perm:request'), false);
  assert.equal(t.opens.length, 0);
});

test('읽기 전용 도구는 묻지 않고 자동 허용한다', async () => {
  const { adapter, responses } = toolAdapter({ name: 'Read', input: { file_path: path.join(workDir, 'a.txt') } });
  const t = setup(adapter);
  await t.host.refresh();
  await t.host.send('읽어줘');
  assert.deepEqual(responses, [['req-1', true, undefined]]);
  assert.equal(t.sent.some(([c]) => c === 'perm:request'), false);
});

test('자동 허용을 끄면 읽기도 묻는다', async () => {
  const { adapter } = toolAdapter({ name: 'Read', input: { file_path: path.join(workDir, 'a.txt') } });
  const t = setup(adapter, { autoAllowRead: false, workDir });
  await t.host.refresh();
  const done = t.host.send('읽어줘');
  await tick();
  assert.ok(t.sent.some(([c]) => c === 'perm:request'));
  t.host.respondPermission('req-1', true);
  await done;
});

test('승인을 기다리는 중 중단하면 카드가 취소로 정리된다', async () => {
  const { adapter } = toolAdapter({ name: 'Bash', input: { command: 'dir' } });
  const t = setup(adapter);
  await t.host.refresh();
  const done = t.host.send('x');
  await tick();
  t.host.abort();
  await done;
  const resolved = t.sent.find(([c]) => c === 'perm:resolved');
  assert.deepEqual(resolved[1], { id: 'req-1', allow: false, auto: true });
  assert.equal(t.host.snapshot().pending.length, 0);
});

test('이미 처리된 요청 ID에 대한 응답은 무시한다', async () => {
  const { adapter, responses } = toolAdapter({ name: 'Bash', input: { command: 'dir' } });
  const t = setup(adapter);
  await t.host.refresh();
  const done = t.host.send('x');
  await tick();
  t.host.respondPermission('req-1', true);
  t.host.respondPermission('req-1', false); // 중복 클릭
  t.host.respondPermission('nope', true);
  await done;
  assert.equal(responses.length, 1);
});
