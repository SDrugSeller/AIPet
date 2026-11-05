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
  const events = translateClaudeMessage({ type: 'result', is_error: true, result: 'Please run /login' }, st);
  assert.deepEqual(events, [{ type: 'error', message: 'Please run /login' }]);
});

test('알 수 없는 메시지는 무시한다', () => {
  assert.deepEqual(translateClaudeMessage({ type: 'rate_limit_event' }, newState()), []);
  assert.deepEqual(translateClaudeMessage(null, newState()), []);
});
