// @ts-check
// Codex CLI / Gemini CLI의 출력 줄을 AgentEvent로 바꾸는 규칙. 줄 형식은 실제 CLI(codex 0.166, gemini 0.67)의 출력과
// 공식 문서에서 가져왔다.
import assert from 'node:assert/strict';
import test from 'node:test';
import { translateCodexLine } from '../src/main/agent/codexCliAdapter.js';
import { friendlyGeminiError, translateGeminiLine } from '../src/main/agent/geminiCliAdapter.js';
import { composePrompt } from '../src/main/agent/cli.js';

const codexState = () => ({ sawText: false, finished: false, lastError: '', text: '', status: null });
const geminiState = () => ({ finished: false, lastError: '', text: '', status: null });

/** @param {any[]} lines @param {any} st @param {Function} fn */
const run = (lines, st, fn) => lines.flatMap((l) => fn(l, st));

test('codex: agent_message가 답변 텍스트가 되고 turn.completed가 끝이다', () => {
  const st = codexState();
  const events = run(
    [
      { type: 'thread.started', thread_id: 'abc' },
      { type: 'turn.started' },
      { type: 'item.completed', item: { id: 'item_3', type: 'agent_message', text: '안녕하세요!' } },
      { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 3 } },
    ],
    st,
    translateCodexLine,
  );
  assert.deepEqual(events, [{ type: 'text', delta: '안녕하세요!' }, { type: 'done' }]);
  assert.equal(st.finished, true);
  assert.equal(st.text, '안녕하세요!');
});

test('codex: 명령 실행/추론 항목은 상태 이벤트가 되고 같은 상태는 반복되지 않는다', () => {
  const st = codexState();
  const events = run(
    [
      { type: 'item.started', item: { id: 'i1', type: 'reasoning' } },
      { type: 'item.started', item: { id: 'i2', type: 'command_execution', command: 'bash -lc ls', status: 'in_progress' } },
      { type: 'item.completed', item: { id: 'i2', type: 'command_execution' } },
    ],
    st,
    translateCodexLine,
  );
  assert.deepEqual(events, [
    { type: 'status', state: 'thinking' },
    { type: 'status', state: 'working' },
  ]);
});

test('codex: 답변이 여러 번 나오면 문단으로 이어 붙인다', () => {
  const st = codexState();
  const events = run(
    [
      { type: 'item.completed', item: { type: 'agent_message', text: '먼저 살펴볼게요.' } },
      { type: 'item.completed', item: { type: 'agent_message', text: '다 봤어요.' } },
    ],
    st,
    translateCodexLine,
  );
  assert.deepEqual(events.map((e) => (e.type === 'text' ? e.delta : '')), ['먼저 살펴볼게요.', '\n\n다 봤어요.']);
});

test('codex: "Reconnecting..." error는 일시적인 안내라서 실패로 보지 않는다', () => {
  const st = codexState();
  const events = run(
    [
      { type: 'error', message: 'Reconnecting... 2/5 (unexpected status 401 Unauthorized: Missing bearer or basic authentication in header)' },
      { type: 'error', message: 'Reconnecting... 3/5 (...)' },
    ],
    st,
    translateCodexLine,
  );
  assert.deepEqual(events, []);
  assert.equal(st.lastError, '');
  assert.equal(st.finished, false);
});

test('codex: 진짜 오류는 기억해 두었다가 turn.failed에서 보여 준다', () => {
  const st = codexState();
  const events = run(
    [{ type: 'error', message: 'stream disconnected before completion' }, { type: 'turn.failed' }],
    st,
    translateCodexLine,
  );
  assert.deepEqual(events, [{ type: 'error', message: 'stream disconnected before completion' }]);
  assert.deepEqual(run([{ type: 'turn.failed', error: { message: '한도 초과' } }], codexState(), translateCodexLine), [{ type: 'error', message: '한도 초과' }]);
});

test('gemini: assistant 델타가 텍스트, result(success)가 끝이다 (user 메시지는 무시)', () => {
  const st = geminiState();
  const events = run(
    [
      { type: 'init', session_id: 's', model: 'auto' },
      { type: 'message', role: 'user', content: '[지침]...' },
      { type: 'message', role: 'assistant', content: '안녕', delta: true },
      { type: 'message', role: 'assistant', content: '하세요', delta: true },
      { type: 'result', status: 'success', stats: {} },
    ],
    st,
    translateGeminiLine,
  );
  assert.deepEqual(events, [{ type: 'text', delta: '안녕' }, { type: 'text', delta: '하세요' }, { type: 'done' }]);
  assert.equal(st.text, '안녕하세요');
});

test('gemini: tool_use는 작업 중 상태, error 이벤트는 기억만 한다 (경고는 무시)', () => {
  const st = geminiState();
  const events = run(
    [
      { type: 'tool_use', tool_name: 'read_file' },
      { type: 'tool_use', tool_name: 'read_file' },
      { type: 'error', severity: 'warning', message: '경고' },
      { type: 'error', severity: 'error', message: '진짜 오류' },
    ],
    st,
    translateGeminiLine,
  );
  assert.deepEqual(events, [{ type: 'status', state: 'working' }]);
  assert.equal(st.lastError, '진짜 오류');
});

test('gemini: 실제 CLI가 보낸 API 키 오류 result를 친절한 문장으로 바꾼다', () => {
  const raw =
    '[API Error: {"error":{"message":"{\\n  \\"error\\": {\\n    \\"code\\": 400,\\n    \\"message\\": \\"API key not valid. Please pass a valid API key.\\",\\n    \\"status\\": \\"INVALID_ARGUMENT\\"\\n  }\\n}\\n","code":400,"status":""}}]';
  const events = translateGeminiLine({ type: 'result', status: 'error', error: { type: 'unknown', message: raw } }, geminiState());
  assert.deepEqual(events, [{ type: 'error', message: 'Gemini API 키가 올바르지 않아요.' }]);
});

test('gemini 오류 문장: 로그인 안내, 한도, 그 외는 안쪽 메시지만 뽑아 짧게', () => {
  assert.match(friendlyGeminiError('Please set an Auth method in your settings.json'), /로그인/);
  assert.match(friendlyGeminiError('RESOURCE_EXHAUSTED: quota'), /한도/);
  assert.equal(friendlyGeminiError('{"error":{"message":"모델이 과부하예요"}}'), '모델이 과부하예요');
  assert.ok(friendlyGeminiError('x'.repeat(1000)).length <= 301);
});

test('composePrompt: 지침, 이전 대화, 새 메시지를 한 프롬프트로 합친다', () => {
  const p = composePrompt({
    system: '말끝에 냥을 붙여',
    history: [
      { role: 'user', text: '안녕' },
      { role: 'assistant', text: '안녕하냥' },
    ],
    message: '이름이 뭐야?',
  });
  assert.match(p, /^\[지침\]\n말끝에 냥을 붙여/);
  assert.match(p, /\[이전 대화\]\n사용자: 안녕\n펫: 안녕하냥/);
  assert.match(p, /\[사용자의 새 메시지\]\n이름이 뭐야\?$/);
  assert.equal(composePrompt({ system: 's', history: [], message: 'm' }).includes('[이전 대화]'), false);
});
