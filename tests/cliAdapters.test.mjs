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

test('codex: 웹 검색 허용을 켜면 -c web_search="live"와 검색 허용 안내를 붙이고, 끄면 붙이지 않는다', { skip }, async () => {
  const { cmd } = fakeCli(`
${readStdin}
const out = (o) => console.log(JSON.stringify(o));
out({ type: 'item.completed', item: { type: 'agent_message', text: 'ARGS=' + process.argv.slice(2).join(' ') + ' | STDIN=' + input.replace(/\\n/g, ' / ') } });
out({ type: 'turn.completed', usage: {} });
`);
  const work = tmpWork();
  const on = text(await collect(createCodexCliAdapter({ getConfig: () => ({ path: cmd, workDir: work, persona: 'p', web: true }) }), '질문'));
  assert.match(on, /-c web_search="live" -/);
  assert.match(on, /--sandbox read-only/); // 검색을 켜도 읽기 전용은 그대로
  assert.match(on, /You may use web search/);
  const off = text(await collect(createCodexCliAdapter({ getConfig: () => ({ path: cmd, workDir: work, persona: 'p', web: false }) }), '질문'));
  assert.doesNotMatch(off, /web_search/);
  assert.match(off, /Do not use web search/);
});

test('gemini: 웹 검색 허용 여부를 시스템 프롬프트로 알려 준다 (실행 옵션은 그대로 plan 모드)', { skip }, async () => {
  const { cmd } = fakeCli(`
${readStdin}
const out = (o) => console.log(JSON.stringify(o));
const reply = 'ARGS=' + process.argv.slice(2).join(' ') + ' | STDIN=' + input.replace(/\\n/g, ' / ');
out({ type: 'message', role: 'assistant', content: reply, delta: true });
out({ type: 'result', status: 'success', stats: {} });
`);
  const work = tmpWork();
  const on = text(await collect(createGeminiCliAdapter({ getConfig: () => ({ path: cmd, workDir: work, persona: 'p', web: true }) }), '질문'));
  assert.match(on, /--approval-mode plan/);
  assert.match(on, /You may use web search/);
  const off = text(await collect(createGeminiCliAdapter({ getConfig: () => ({ path: cmd, workDir: work, persona: 'p', web: false }) }), '질문'));
  assert.match(off, /Do not use web search/);
});

test('claude: 이어 말하던 세션이 만료되면 새 대화로 한 번 다시 시도하고 구분선 이벤트를 남긴다', { skip }, async () => {
  // 가짜 claude: --resume이 붙어 있으면 실제 CLI처럼 "세션 없음" 오류로 끝나고, 없으면 정상 답변
  const { cmd } = fakeCli(`
${readFirstLine}
const out = (o) => console.log(JSON.stringify(o));
const i = process.argv.indexOf('--resume');
if (i >= 0) {
  const id = process.argv[i + 1];
  out({ type: 'result', subtype: 'error_during_execution', is_error: true, session_id: id, errors: ['No conversation found with session ID: ' + id] });
} else {
  out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: '새 대화 답변' } } });
  out({ type: 'result', subtype: 'success', is_error: false, session_id: 'fresh', result: '새 대화 답변' });
}
`);
  const work = tmpWork();
  const a = createClaudeCodeAdapter({
    getConfig: () => ({ path: cmd, tools: false, workDir: work, persona: '냥' }),
    metaDir: path.join(work, 'meta'),
  });
  // 첫 대화에서 세션을 저장해 둔 상태를 만든다 (이 가짜 CLI는 --resume이 없으면 정상 답변)
  const first = await collect(a, '첫 질문');
  assert.equal(text(first), '새 대화 답변');
  assert.equal(first.some((e) => e.type === 'session'), false); // 처음에는 표시가 없다

  // 두 번째부터는 --resume fresh가 붙어 가짜 CLI가 "세션 없음"으로 실패한다 → 새 대화로 재시도
  const second = await collect(a, '두 번째 질문');
  assert.equal(second.filter((e) => e.type === 'error').length, 0); // 사용자에게 오류로 보이지 않는다
  const marks = second.filter((e) => e.type === 'session');
  assert.equal(marks.length, 1);
  assert.match(/** @type {any} */ (marks[0]).text, /세션이 만료/);
  assert.equal(text(second), '새 대화 답변'); // 같은 질문으로 새 대화가 이어서 답한다
  assert.equal(second.at(-1)?.type, 'done');

  // 죽은 세션을 계속 붙잡지 않는다: 세 번째 질문도 (다시 저장된 세션으로) 같은 흐름이며, 멈춰 있지 않다
  const third = await collect(a, '세 번째 질문');
  assert.equal(third.at(-1)?.type, 'done');
});

test('claude: 말투/도구 등 설정이 바뀌어 세션을 이을 수 없으면 새 대화로 시작한다는 표시를 남긴다', { skip }, async () => {
  const { cmd } = fakeCli(`
${readFirstLine}
const out = (o) => console.log(JSON.stringify(o));
out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'resume=' + process.argv.includes('--resume') } } });
out({ type: 'result', subtype: 'success', is_error: false, session_id: 's-9', result: 'ok' });
`);
  const work = tmpWork();
  let persona = '냥';
  const a = createClaudeCodeAdapter({
    getConfig: () => ({ path: cmd, tools: false, workDir: work, persona }),
    metaDir: path.join(work, 'meta'),
  });
  assert.equal(text(await collect(a, '1')), 'resume=false');
  const same = await collect(a, '2');
  assert.equal(text(same), 'resume=true'); // 설정이 같으면 이어 말한다
  assert.equal(same.some((e) => e.type === 'session'), false);
  persona = '멍'; // 말투 변경 → 이전 세션을 이을 수 없다
  const changed = await collect(a, '3');
  assert.equal(text(changed), 'resume=false');
  assert.equal(changed.filter((e) => e.type === 'session').length, 1);
});

test('codex: 기본은 읽기 전용 샌드박스, 쓰기 허용 설정이면 workspace-write와 샌드박스 안내 프롬프트로 실행한다', { skip }, async () => {
  const { cmd } = fakeCli(`
${readStdin}
const out = (o) => console.log(JSON.stringify(o));
out({ type: 'item.completed', item: { type: 'agent_message', text: 'ARGS=' + process.argv.slice(2).join(' ') + ' | STDIN=' + input.replace(/\\n/g, ' / ') } });
out({ type: 'turn.completed', usage: {} });
`);
  const work = tmpWork();
  const read = text(await collect(createCodexCliAdapter({ getConfig: () => ({ path: cmd, workDir: work, persona: 'p' }) }), '질문'));
  assert.match(read, /--sandbox read-only/);
  assert.doesNotMatch(read, /workspace-write/);
  assert.match(read, /cannot modify files|do not offer to/); // 읽기 전용 안내

  const write = text(await collect(createCodexCliAdapter({ getConfig: () => ({ path: cmd, workDir: work, persona: 'p', write: true }) }), '질문'));
  assert.match(write, /--sandbox workspace-write/);
  assert.doesNotMatch(write, /--sandbox read-only/);
  assert.doesNotMatch(write, /danger-full-access|dangerously-bypass/); // 샌드박스를 끄는 옵션은 절대 쓰지 않는다
  assert.match(write, /sandboxed/); // 샌드박스 안내
});

test('codex: 쓰기 모드에서 실행한 명령은 trace 이벤트로 나오고, 읽기 전용에서는 나오지 않는다', { skip }, async () => {
  const { cmd } = fakeCli(`
${readStdin}
const out = (o) => console.log(JSON.stringify(o));
const c = { id: 'item_1', type: 'command_execution', command: 'node --version' };
out({ type: 'item.started', item: { ...c, status: 'in_progress' } });
out({ type: 'item.completed', item: { ...c, status: 'completed', exit_code: 0 } });
out({ type: 'item.completed', item: { type: 'agent_message', text: '끝' } });
out({ type: 'turn.completed', usage: {} });
`);
  const work = tmpWork();
  const on = await collect(createCodexCliAdapter({ getConfig: () => ({ path: cmd, workDir: work, write: true }) }), '실행해줘');
  assert.deepEqual(on.filter((e) => e.type === 'trace'), [{ type: 'trace', text: '자동 허용 · 명령 실행 (Codex): node --version' }]);
  const off = await collect(createCodexCliAdapter({ getConfig: () => ({ path: cmd, workDir: work }) }), '실행해줘');
  assert.equal(off.some((e) => e.type === 'trace'), false);
});

test('claude: reset() 뒤에는 이전 세션을 이어 붙이지 않고 새 세션으로 시작한다', { skip }, async () => {
  const { cmd } = fakeCli(`
${readFirstLine}
const out = (o) => console.log(JSON.stringify(o));
out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'resume=' + process.argv.includes('--resume') } } });
out({ type: 'result', subtype: 'success', is_error: false, session_id: 's-' + Date.now(), result: 'ok' });
`);
  const work = tmpWork();
  const a = createClaudeCodeAdapter({ getConfig: () => ({ path: cmd, tools: false, workDir: work, persona: 'p' }), metaDir: path.join(work, 'meta') });
  assert.equal(text(await collect(a, '1')), 'resume=false');
  assert.equal(text(await collect(a, '2')), 'resume=true'); // 이어 말한다
  a.reset?.();
  assert.equal(text(await collect(a, '3')), 'resume=false'); // 새 대화
  assert.equal(text(await collect(a, '4')), 'resume=true'); // 새 세션을 다시 이어 간다
});

test('codex: reset() 뒤에는 앞선 대화를 프롬프트에 붙이지 않는다', { skip }, async () => {
  const { cmd } = fakeCli(`
${readStdin}
const out = (o) => console.log(JSON.stringify(o));
out({ type: 'item.completed', item: { type: 'agent_message', text: input.includes('[이전 대화]') ? 'HAS_HISTORY' : 'NO_HISTORY' } });
out({ type: 'turn.completed', usage: {} });
`);
  const work = tmpWork();
  const a = createCodexCliAdapter({ getConfig: () => ({ path: cmd, workDir: work, persona: 'p' }) });
  assert.equal(text(await collect(a, '첫 질문')), 'NO_HISTORY'); // 아직 앞선 대화가 없다
  assert.equal(text(await collect(a, '두 번째')), 'HAS_HISTORY'); // 앞선 대화가 붙는다
  a.reset?.();
  assert.equal(text(await collect(a, '세 번째')), 'NO_HISTORY');
});
