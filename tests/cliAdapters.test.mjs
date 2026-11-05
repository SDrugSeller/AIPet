// @ts-check
// 가짜 CLI(작은 스크립트)로 실제 프로세스 실행 경로를 확인한다: stdin 전달, 환경변수(계정 분리), 출력 파싱, 종료 처리.
// 실행 파일을 .cmd 셔임으로 만들기 때문에 Windows에서만 돈다.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createClaudeCodeAdapter } from '../src/main/agent/claudeCodeAdapter.js';
import { createCodexCliAdapter } from '../src/main/agent/codexCliAdapter.js';
import { createGeminiCliAdapter } from '../src/main/agent/geminiCliAdapter.js';

const onWindows = process.platform === 'win32';
const skip = onWindows ? false : 'Windows에서만 실행 (.cmd 셔임 사용)';

/** 스크립트(JS 본문)를 실행하는 가짜 CLI 실행 파일(.cmd)을 만든다. @param {string} body */
function fakeCli(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aipet-fakecli-'));
  fs.writeFileSync(path.join(dir, 'fake.mjs'), body);
  const cmd = path.join(dir, 'fake.cmd');
  fs.writeFileSync(cmd, `@echo off\r\n"${process.execPath}" "${path.join(dir, 'fake.mjs')}" %*\r\n`);
  return { cmd, dir };
}

/** @param {import('../src/main/agent/adapter.js').AgentAdapter} adapter @param {string} msg */
async function collect(adapter, msg) {
  const events = [];
  for await (const ev of adapter.send(msg)) events.push(ev);
  return events;
}

const text = (/** @type {any[]} */ events) => events.filter((e) => e.type === 'text').map((e) => e.delta).join('');
const tmpWork = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aipet-work-'));

// 가짜 claude: 사용자 메시지 한 줄만 읽는다 (어댑터는 결과를 받은 뒤에야 stdin을 닫는다)
const readFirstLine = `let input = ''; process.stdin.setEncoding('utf8'); for await (const c of process.stdin) { input += c; if (input.includes('\\n')) break; }`;

// 가짜 codex/gemini: stdin을 모두 읽어서 돌려준다
const readStdin = `let input = ''; process.stdin.setEncoding('utf8'); for await (const c of process.stdin) input += c;`;

test('claude: 계정 설정 폴더(CLAUDE_CONFIG_DIR)를 환경변수로 넘기고, 입력은 stdin JSON으로 보낸다', { skip }, async () => {
  const { cmd } = fakeCli(`
${readFirstLine}
const user = JSON.parse(input.split('\\n')[0]);
const out = (o) => console.log(JSON.stringify(o));
out({ type: 'system', subtype: 'init', session_id: 's-1' });
const reply = 'dir=' + process.env.CLAUDE_CONFIG_DIR + ' msg=' + user.message.content[0].text + ' args=' + process.argv.slice(2).join(' ');
out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: reply } } });
out({ type: 'result', subtype: 'success', is_error: false, session_id: 's-1', result: reply });
`);
  const work = tmpWork();
  const a = createClaudeCodeAdapter({
    getConfig: () => ({ path: cmd, configDir: 'D:\\accounts\\work', tools: false, workDir: work, persona: '냥' }),
    metaDir: path.join(work, 'meta'),
  });
  const events = await collect(a, '안녕 "따옴표" & 특수문자');
  const reply = text(events);
  assert.match(reply, /dir=D:\\accounts\\work/); // 계정 분리
  assert.match(reply, /msg=안녕 "따옴표" & 특수문자/); // 입력이 인자가 아니라 stdin으로 안전하게 전달됨
  assert.match(reply, /--tools /); // 도구 끔
  assert.match(reply, /--permission-prompt-tool stdio/);
  assert.equal(events.at(-1)?.type, 'done');
});

test('claude: 계정 폴더가 없으면 CLAUDE_CONFIG_DIR을 건드리지 않는다', { skip }, async () => {
  const { cmd } = fakeCli(`
${readFirstLine}
const out = (o) => console.log(JSON.stringify(o));
out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'dir=' + (process.env.CLAUDE_CONFIG_DIR ?? '(없음)') } } });
out({ type: 'result', is_error: false, session_id: 's' });
`);
  const saved = process.env.CLAUDE_CONFIG_DIR;
  delete process.env.CLAUDE_CONFIG_DIR;
  try {
    const work = tmpWork();
    const a = createClaudeCodeAdapter({ getConfig: () => ({ path: cmd, configDir: '', tools: true, workDir: work }), metaDir: path.join(work, 'm') });
    assert.match(text(await collect(a, 'x')), /dir=\(없음\)/);
  } finally {
    if (saved) process.env.CLAUDE_CONFIG_DIR = saved;
  }
});

test('claude: 계정(설정 폴더)이 바뀌면 이전 대화 세션을 이어 말하지 않는다', { skip }, async () => {
  const { cmd } = fakeCli(`
${readFirstLine}
const out = (o) => console.log(JSON.stringify(o));
const resumed = process.argv.includes('--resume') ? 'RESUME' : 'NEW';
out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: resumed } } });
out({ type: 'result', is_error: false, session_id: 'sess-1' });
`);
  const work = tmpWork();
  let dir = 'A';
  const a = createClaudeCodeAdapter({ getConfig: () => ({ path: cmd, configDir: dir, tools: false, workDir: work }), metaDir: path.join(work, 'm') });
  assert.equal(text(await collect(a, '1')), 'NEW');
  assert.equal(text(await collect(a, '2')), 'RESUME'); // 같은 계정이면 이어 말한다
  dir = 'B';
  assert.equal(text(await collect(a, '3')), 'NEW'); // 계정이 바뀌면 새 대화
});

test('codex: 프롬프트(말투+기록+메시지)는 stdin으로, 읽기 전용 샌드박스 옵션으로 실행한다', { skip }, async () => {
  const { cmd } = fakeCli(`
${readStdin}
const out = (o) => console.log(JSON.stringify(o));
out({ type: 'thread.started', thread_id: 't' });
out({ type: 'turn.started' });
out({ type: 'error', message: 'Reconnecting... 1/5 (일시적)' });
out({ type: 'item.completed', item: { type: 'agent_message', text: 'ARGS=' + process.argv.slice(2).join(' ') + ' | STDIN=' + input.replace(/\\n/g, ' / ') } });
out({ type: 'turn.completed', usage: {} });
`);
  const work = tmpWork();
  const a = createCodexCliAdapter({ getConfig: () => ({ path: cmd, model: 'gpt-x', workDir: work, persona: '말끝에 냥을 붙여' }) });
  const first = await collect(a, '첫 질문');
  const reply = text(first);
  assert.match(reply, /ARGS=exec --json --skip-git-repo-check --ephemeral --sandbox read-only -m gpt-x -/);
  assert.match(reply, /STDIN=\[지침\] \/ 말끝에 냥을 붙여/);
  assert.match(reply, /\[사용자의 새 메시지\] \/ 첫 질문/);
  assert.equal(first.some((e) => e.type === 'error'), false); // 재연결 안내는 오류가 아니다
  assert.equal(first.at(-1)?.type, 'done');

  // 두 번째 질문에는 이전 대화가 프롬프트에 포함된다 (CLI 세션이 아니라 앱이 기록을 이어 준다)
  assert.match(text(await collect(a, '둘째 질문')), /\[이전 대화\] \/ 사용자: 첫 질문 \/ 펫: ARGS=/);
  a.reset?.();
  assert.doesNotMatch(text(await collect(a, '셋째')), /\[이전 대화\]/);
});

test('codex: turn.failed로 끝나면 오류, 아무 결과 없이 죽으면 stderr의 마지막 줄을 오류로 보여 준다', { skip }, async () => {
  const failed = fakeCli(`${readStdin}
console.log(JSON.stringify({ type: 'turn.failed', error: { message: '로그인이 필요해요' } }));
`);
  const work = tmpWork();
  const a = createCodexCliAdapter({ getConfig: () => ({ path: failed.cmd, workDir: work }) });
  const events = await collect(a, 'x');
  assert.deepEqual(events.filter((e) => e.type === 'error'), [{ type: 'error', message: '로그인이 필요해요' }]);

  const crashed = fakeCli(`${readStdin}
console.error('치명적 오류가 났어요'); process.exit(3);
`);
  const b = createCodexCliAdapter({ getConfig: () => ({ path: crashed.cmd, workDir: work }) });
  const ev2 = await collect(b, 'x');
  assert.match(/** @type {any} */ (ev2.at(-1)).message, /치명적 오류/);
});

test('gemini: plan(읽기 전용) 모드로 실행하고 프롬프트는 stdin, 델타 텍스트를 이어 받는다', { skip }, async () => {
  const { cmd } = fakeCli(`
${readStdin}
const out = (o) => console.log(JSON.stringify(o));
out({ type: 'init', session_id: 's', model: 'auto' });
out({ type: 'message', role: 'user', content: input });
const reply = 'ARGS=' + process.argv.slice(2).join(' ') + ' | STDIN=' + input.replace(/\\n/g, ' / ');
out({ type: 'message', role: 'assistant', content: reply.slice(0, 20), delta: true });
out({ type: 'message', role: 'assistant', content: reply.slice(20), delta: true });
out({ type: 'result', status: 'success', stats: {} });
`);
  const work = tmpWork();
  const a = createGeminiCliAdapter({ getConfig: () => ({ path: cmd, model: 'gemini-x', workDir: work, persona: '존댓말로 답해' }) });
  const events = await collect(a, '안녕하세요');
  const reply = text(events);
  assert.match(reply, /--approval-mode plan/);
  assert.match(reply, /--output-format stream-json/);
  assert.match(reply, /-m gemini-x/);
  assert.match(reply, /STDIN=\[지침\] \/ 존댓말로 답해/);
  assert.match(reply, /\[사용자의 새 메시지\] \/ 안녕하세요/);
  assert.equal(events.at(-1)?.type, 'done');
});

test('gemini: result(error)는 친절한 오류 문장으로 바뀐다', { skip }, async () => {
  const { cmd } = fakeCli(`${readStdin}
console.log(JSON.stringify({ type: 'result', status: 'error', error: { type: 'unknown', message: '[API Error: API key not valid. Please pass a valid API key.]' } }));
process.exit(1);
`);
  const a = createGeminiCliAdapter({ getConfig: () => ({ path: cmd, workDir: tmpWork() }) });
  const events = await collect(a, 'x');
  assert.deepEqual(events.filter((e) => e.type === 'error'), [{ type: 'error', message: 'Gemini API 키가 올바르지 않아요.' }]);
});

test('중단하면 가짜 CLI(와 그 아래 프로세스)가 끝나고 오류 없이 마무리된다', { skip }, async () => {
  const { cmd } = fakeCli(`${readStdin}
console.log(JSON.stringify({ type: 'turn.started' }));
setInterval(() => {}, 1000); // 끝나지 않는다
`);
  const a = createCodexCliAdapter({ getConfig: () => ({ path: cmd, workDir: tmpWork() }) });
  const started = Date.now();
  const events = [];
  for await (const ev of a.send('x')) {
    events.push(ev);
    if (ev.type === 'status') setTimeout(() => a.abort(), 300);
  }
  assert.ok(Date.now() - started < 15_000);
  assert.equal(events.some((e) => e.type === 'error'), false);
});

test('경로를 직접 지정했는데 파일이 없으면 다른 곳을 뒤지지 않고 안내한다', async () => {
  for (const make of [
    () => createCodexCliAdapter({ getConfig: () => ({ path: 'C:\\없는\\codex.exe', workDir: tmpWork() }) }),
    () => createGeminiCliAdapter({ getConfig: () => ({ path: 'C:\\없는\\gemini.exe', workDir: tmpWork() }) }),
    () => createClaudeCodeAdapter({ getConfig: () => ({ path: 'C:\\없는\\claude.exe', tools: false, workDir: tmpWork() }), metaDir: tmpWork() }),
  ]) {
    const d = await make().detect();
    assert.equal(d.ok, false);
    assert.match(d.reason ?? '', /지정한 경로/);
  }
});
