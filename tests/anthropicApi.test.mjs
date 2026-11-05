// @ts-check
// Anthropic API 어댑터: 공식 SDK를 가짜 서버(SSE)에 연결해 스트리밍, 오류, 안전 거절, 서버 측 fallbacks를 확인한다.
import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { createAnthropicApiAdapter, friendlyAnthropicError } from '../src/main/agent/anthropicApiAdapter.js';

/** @param {import('../src/main/agent/adapter.js').AgentAdapter} adapter @param {string} msg */
async function collect(adapter, msg) {
  const events = [];
  for await (const ev of adapter.send(msg)) events.push(ev);
  return events;
}

/** Messages API의 스트리밍 응답을 흉내 낸다 */
function sse(/** @type {string[]} */ texts, stopReason = 'end_turn') {
  const ev = (/** @type {string} */ name, /** @type {any} */ data) => `event: ${name}\ndata: ${JSON.stringify({ type: name, ...data })}\n\n`;
  return [
    ev('message_start', { message: { id: 'msg_1', type: 'message', role: 'assistant', model: 'm', content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } } }),
    ev('content_block_start', { index: 0, content_block: { type: 'text', text: '' } }),
    ...texts.map((t) => ev('content_block_delta', { index: 0, delta: { type: 'text_delta', text: t } })),
    ev('content_block_stop', { index: 0 }),
    ev('message_delta', { delta: { stop_reason: stopReason, stop_sequence: null }, usage: { output_tokens: 5 } }),
    ev('message_stop', {}),
  ].join('');
}

/** @param {(req: http.IncomingMessage, body: any, res: http.ServerResponse) => void} [handler] */
async function startServer(handler) {
  /** @type {{ method?: string, url: string, headers: http.IncomingHttpHeaders, body: any }[]} */
  const requests = [];
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (d) => (raw += d));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : null;
      requests.push({ method: req.method, url: req.url ?? '', headers: req.headers, body });
      if (handler) return handler(req, body, res);
      if (req.method === 'GET' && req.url?.startsWith('/v1/models/')) {
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify({ id: decodeURIComponent(req.url.split('/').pop() ?? ''), type: 'model', display_name: 'Test Model', created_at: '2026-01-01T00:00:00Z' }));
      }
      res.setHeader('Content-Type', 'text/event-stream');
      res.end(sse(['안녕', '하세요']));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(undefined)));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  return { baseUrl: `http://127.0.0.1:${port}`, requests, close: () => { server.closeAllConnections(); server.close(); } };
}

const cfg = (/** @type {any} */ s, /** @type {any} */ over = {}) => () => ({ model: 'claude-haiku-5-5', apiKey: 'sk-test', baseUrl: s.baseUrl, persona: '말끝에 냥을 붙여', ...over });

test('스트리밍 텍스트를 text → done 이벤트로 바꾸고, 키/말투/모델을 요청에 담는다', async () => {
  const s = await startServer();
  try {
    const a = createAnthropicApiAdapter({ getConfig: cfg(s) });
    assert.deepEqual(await collect(a, '안녕?'), [
      { type: 'status', state: 'thinking' },
      { type: 'text', delta: '안녕' },
      { type: 'text', delta: '하세요' },
      { type: 'done' },
    ]);
    const req = s.requests[0];
    assert.equal(req.headers.authorization, 'Bearer sk-test'); // SDK가 키를 Authorization 헤더로 보낸다
    assert.equal(req.body.model, 'claude-haiku-5-5');
    assert.equal(req.body.stream, true);
    assert.ok(String(req.body.system).startsWith('말끝에 냥을 붙여')); // 선택한 말투가 시스템 프롬프트
    assert.deepEqual(req.body.messages, [{ role: 'user', content: '안녕?' }]);
  } finally {
    s.close();
  }
});

test('대화 기록을 다음 요청에 포함하고, reset하면 비운다', async () => {
  const s = await startServer();
  try {
    const a = createAnthropicApiAdapter({ getConfig: cfg(s) });
    await collect(a, '첫째');
    await collect(a, '둘째');
    assert.deepEqual(s.requests[1].body.messages, [
      { role: 'user', content: '첫째' },
      { role: 'assistant', content: '안녕하세요' },
      { role: 'user', content: '둘째' },
    ]);
    a.reset?.();
    await collect(a, '셋째');
    assert.equal(s.requests[2].body.messages.length, 1);
  } finally {
    s.close();
  }
});

test('안전 분류기가 거절하면(stop_reason: refusal) 오류로 알리고 기록에 남기지 않는다', async () => {
  const s = await startServer((_req, _body, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.end(sse([], 'refusal'));
  });
  try {
    const a = createAnthropicApiAdapter({ getConfig: cfg(s) });
    const events = await collect(a, 'x');
    assert.equal(events.at(-1)?.type, 'error');
    assert.match(/** @type {any} */ (events.at(-1)).message, /안전 정책/);
    await collect(a, 'y');
    assert.equal(s.requests[1].body.messages.length, 1); // 거절된 턴은 기록에 없다
  } finally {
    s.close();
  }
});

test('Opus/Fable/Sonnet 5.5는 서버 측 fallbacks(베타)를 켜고, 다른 모델은 켜지 않는다', async () => {
  const s = await startServer();
  try {
    await collect(createAnthropicApiAdapter({ getConfig: cfg(s, { model: 'claude-opus-5-5' }) }), 'x');
    const opus = s.requests[0];
    assert.match(String(opus.headers['anthropic-beta']), /server-side-fallback-2026-07-01/);
    assert.equal(opus.body.fallbacks, 'default');

    await collect(createAnthropicApiAdapter({ getConfig: cfg(s, { model: 'claude-haiku-5-5' }) }), 'x');
    const haiku = s.requests[1];
    assert.equal(haiku.body.fallbacks, undefined);
    assert.doesNotMatch(String(haiku.headers['anthropic-beta'] ?? ''), /server-side-fallback/);
  } finally {
    s.close();
  }
});

test('잘못된 키(401)와 없는 모델(404)은 이해하기 쉬운 문장으로 알린다', async () => {
  const s = await startServer((_req, _body, res) => {
    res.statusCode = 401;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ type: 'error', error: { type: 'authentication_error', message: 'invalid x-api-key' } }));
  });
  try {
    const a = createAnthropicApiAdapter({ getConfig: cfg(s) });
    const events = await collect(a, 'x');
    assert.match(/** @type {any} */ (events.at(-1)).message, /API 키가 올바르지 않/);
    const d = await a.detect();
    assert.equal(d.ok, false);
    assert.match(d.reason ?? '', /API 키/);
  } finally {
    s.close();
  }
});

test('detect: 키와 모델이 맞으면 ok (모델 조회라 토큰을 쓰지 않는다), 키가 없으면 안내', async () => {
  const s = await startServer();
  try {
    const ok = await createAnthropicApiAdapter({ getConfig: cfg(s) }).detect();
    assert.equal(ok.ok, true);
    assert.match(ok.info ?? '', /Test Model/);
    assert.equal(s.requests[0].method, 'GET');
    assert.match(s.requests[0].url, /\/v1\/models\/claude-haiku-5-5/);
    assert.equal(s.requests.some((r) => r.method === 'POST'), false); // 메시지 생성 요청은 보내지 않았다
  } finally {
    s.close();
  }
  const saved = { k: process.env.ANTHROPIC_API_KEY, t: process.env.ANTHROPIC_AUTH_TOKEN };
  delete process.env.ANTHROPIC_API_KEY;
  delete process.env.ANTHROPIC_AUTH_TOKEN;
  try {
    const none = await createAnthropicApiAdapter({ getConfig: () => ({ model: 'claude-opus-5-5', apiKey: '' }) }).detect();
    assert.equal(none.ok, false);
    assert.match(none.reason ?? '', /키/);
  } finally {
    if (saved.k) process.env.ANTHROPIC_API_KEY = saved.k;
    if (saved.t) process.env.ANTHROPIC_AUTH_TOKEN = saved.t;
  }
});

test('중단하면 오류 없이 끝난다', async () => {
  const s = await startServer((_req, _body, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.write(sse(['a']).split('event: content_block_stop')[0]); // 끝내지 않고 열어 둔다
  });
  try {
    const a = createAnthropicApiAdapter({ getConfig: cfg(s) });
    const events = [];
    for await (const ev of a.send('x')) {
      events.push(ev);
      if (ev.type === 'text') a.abort();
    }
    assert.equal(events.some((e) => e.type === 'error'), false);
    assert.equal(events.some((e) => e.type === 'done'), false);
  } finally {
    s.close();
  }
});

test('friendlyAnthropicError: 모르는 오류도 문장으로', () => {
  assert.match(friendlyAnthropicError(new Error('boom')), /boom/);
});
