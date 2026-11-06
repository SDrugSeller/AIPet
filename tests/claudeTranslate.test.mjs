// @ts-check
import assert from 'node:assert/strict';
import test from 'node:test';
import { translateClaudeMessage } from '../src/main/agent/claudeCodeAdapter.js';

const newState = () => ({ sawDelta: false, finished: false, status: null, sessionId: null });

/** 실제 `claude -p --output-format stream-json --include-partial-messages` 출력에서 따온 줄 */
const streamLines = [
  { type: 'system', subtype: 'init', session_id: 's-1', tools: [] },
  { type: 'system', subtype: 'status', status: 'requesting', session_id: 's-1' },
  { type: 'stream_event', event: { type: 'message_start', message: {} } },
  { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
  { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '안녕' } } },
  { type: 'stream_event', event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: '!' } } },
  { type: 'assistant', message: { content: [{ type: 'text', text: '안녕!' }] } },
  { type: 'result', subtype: 'success', is_error: false, session_id: 's-1', result: '안녕!' },
];

test('스트림 델타는 text 이벤트로, result는 done으로 변환된다', () => {
  const st = newState();
  const events = streamLines.flatMap((m) => translateClaudeMessage(m, st));
  assert.deepEqual(events, [
    { type: 'text', delta: '안녕' },
    { type: 'text', delta: '!' },
    { type: 'done' },
  ]);
  assert.equal(st.sessionId, 's-1');
  assert.equal(st.finished, true);
});

test('델타 없이 완성된 assistant 메시지만 오면 그 텍스트를 쓴다', () => {
  const st = newState();
  const events = [streamLines[6], streamLines[7]].flatMap((m) => translateClaudeMessage(m, st));
  assert.deepEqual(events, [{ type: 'text', delta: '안녕!' }, { type: 'done' }]);
});

test('thinking/tool_use 블록은 status 이벤트로 변환되고 같은 상태는 반복되지 않는다', () => {
  const st = newState();
  const start = (/** @type {string} */ t) => ({
    type: 'stream_event',
    event: { type: 'content_block_start', content_block: { type: t } },
  });
  assert.deepEqual(translateClaudeMessage(start('thinking'), st), [{ type: 'status', state: 'thinking' }]);
  assert.deepEqual(translateClaudeMessage(start('thinking'), st), []);
  assert.deepEqual(translateClaudeMessage(start('tool_use'), st), [{ type: 'status', state: 'working' }]);
});

test('is_error 결과는 error 이벤트가 된다', () => {
  const st = newState();
  const events = translateClaudeMessage({ type: 'result', is_error: true, result: 'API Error: 529 overloaded' }, st);
  assert.deepEqual(events, [{ type: 'error', message: 'API Error: 529 overloaded' }]);
  assert.equal(st.failed, true);
});

// 실제 `claude -p`(로그인 안 된 설정 폴더)에서 확인한 출력: 안내 문장이 "답변"과 "결과"에 두 번 실려 온다
const loggedOut = [
  { type: 'assistant', error: 'authentication_failed', message: { model: '<synthetic>', content: [{ type: 'text', text: 'Not logged in · Please run /login' }] } },
  { type: 'result', subtype: 'success', is_error: true, result: 'Not logged in · Please run /login', terminal_reason: 'api_error' },
];

test('로그인이 풀리면 안내를 답변으로 한 번 더 보이지 않고, 세션 만료 표시와 다시 로그인하라는 오류만 낸다', () => {
  const st = newState();
  const events = loggedOut.flatMap((m) => translateClaudeMessage(m, st));
  assert.equal(events.filter((e) => e.type === 'text').length, 0); // 같은 문장이 답변 말풍선으로 또 나오지 않는다
  assert.deepEqual(events[0], { type: 'session', text: '로그인 세션이 만료됐어요' });
  assert.equal(events[1].type, 'error');
  assert.match(/** @type {any} */ (events[1]).message, /\/login/);
  assert.match(/** @type {any} */ (events[1]).message, /Not logged in/); // 원문도 함께 남긴다
  assert.equal(events.length, 2);
});

test('이어 말하려던 세션이 없으면 오류로 내지 않고 sessionLost로 표시한다 (어댑터가 새 대화로 다시 시도)', () => {
  // 실제 출력: result에 result 필드 없이 errors만 있다
  const lost = { type: 'result', subtype: 'error_during_execution', is_error: true, session_id: 'old', errors: ['No conversation found with session ID: old'] };
  const st = { ...newState(), resumed: true };
  assert.deepEqual(translateClaudeMessage(lost, st), []);
  assert.equal(st.sessionLost, true);
  assert.equal(st.failed, true);
  // 이어 말하려던 게 아니면(첫 대화) 같은 메시지도 그냥 오류다
  const first = newState();
  const events = translateClaudeMessage(lost, first);
  assert.equal(events[0].type, 'error');
  assert.match(/** @type {any} */ (events[0]).message, /No conversation found/);
});

test('알 수 없는 메시지는 무시한다', () => {
  assert.deepEqual(translateClaudeMessage({ type: 'rate_limit_event' }, newState()), []);
  assert.deepEqual(translateClaudeMessage(null, newState()), []);
});

test('can_use_tool 제어 요청은 tool_request가 되고, 허용 응답용 입력을 기억한다', () => {
  const st = { sawDelta: false, finished: false, status: null, sessionId: null };
  const events = translateClaudeMessage(
    {
      type: 'control_request',
      request_id: 'r-1',
      request: { subtype: 'can_use_tool', tool_name: 'Write', input: { file_path: 'a.txt', content: 'hi' } },
    },
    /** @type {any} */ (st),
  );
  assert.deepEqual(events, [{ type: 'tool_request', id: 'r-1', name: 'Write', input: { file_path: 'a.txt', content: 'hi' } }]);
  assert.deepEqual(/** @type {any} */ (st).requests.get('r-1'), { file_path: 'a.txt', content: 'hi' });
});

test('can_use_tool이 아닌 제어 요청은 무시한다', () => {
  const events = translateClaudeMessage({ type: 'control_request', request_id: 'r-2', request: { subtype: 'hook_callback' } }, newState());
  assert.deepEqual(events, []);
});
