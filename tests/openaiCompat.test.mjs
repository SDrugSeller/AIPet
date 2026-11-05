// @ts-check
import assert from 'node:assert/strict';
import http from 'node:http';
import test from 'node:test';
import { createOpenAICompatAdapter } from '../src/main/agent/openaiCompatAdapter.js';

/** @param {import('../src/main/agent/adapter.js').AgentAdapter} adapter @param {string} msg */
async function collect(adapter, msg) {
  const events = [];
  for await (const ev of adapter.send(msg)) events.push(ev);
  return events;
}

/**
 * 가짜 OpenAI 호환 서버. 받은 요청을 requests에 모은다.
 * @param {(req: http.IncomingMessage, body: string, res: http.ServerResponse) => void} [onChat]
 */
async function startServer(onChat) {
  /** @type {{ url: string, body: any, auth?: string }[]} */
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => (body += d));
    req.on('end', () => {
      if (req.url === '/v1/models') {
        res.setHeader('Content-Type', 'application/json');
        return res.end(JSON.stringify({ data: [{ id: 'tiny-model' }] }));
      }
      requests.push({ url: req.url ?? '', body: JSON.parse(body), auth: req.headers.authorization });
      if (onChat) return onChat(req, body, res);
      res.setHeader('Content-Type', 'text/event-stream');
      // 청크 경계가 SSE 줄 중간에 걸리도록 일부러 쪼개서 보낸다
      const chunk = (/** @type {string} */ t) => `data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`;
      const payload = chunk('안') + chunk('녕') + 'data: [DONE]\n\n';
      res.write(payload.slice(0, 20));
      setTimeout(() => {
        res.write(payload.slice(20));
        res.end();
      }, 10);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', () => r(undefined)));
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address());
  return { baseUrl: `http://127.0.0.1:${port}/v1`, requests, close: () => { server.closeAllConnections(); server.close(); } };
}

test('detect: 서버가 있으면 ok이고 모델을 자동 선택한다', async () => {
  const s = await startServer();
  const a = createOpenAICompatAdapter({ baseUrl: s.baseUrl });
  assert.deepEqual(await a.detect(), { ok: true });
  await collect(a, 'hi');
  assert.equal(s.requests[0].body.model, 'tiny-model');
  s.close();
});

test('detect: 서버가 없으면 안내 메시지와 함께 ok=false', async () => {
  const a = createOpenAICompatAdapter({ baseUrl: 'http://127.0.0.1:1/v1' });
  const r = await a.detect();
  assert.equal(r.ok, false);
  assert.match(r.reason ?? '', /연결할 수 없어요/);
});

test('detect: http(s)가 아닌 주소는 거부한다', async () => {
  const a = createOpenAICompatAdapter({ baseUrl: 'file:///etc/passwd' });
  assert.equal((await a.detect()).ok, false);
});

test('send: SSE를 text → done 이벤트로 변환하고, 대화 기록을 다음 요청에 포함한다', async () => {
  const s = await startServer();
  const a = createOpenAICompatAdapter({ baseUrl: s.baseUrl, model: 'm', apiKey: 'k-123' });

  assert.deepEqual(await collect(a, '안녕?'), [
    { type: 'status', state: 'thinking' },
    { type: 'text', delta: '안' },
    { type: 'text', delta: '녕' },
    { type: 'done' },
  ]);
  await collect(a, '또 안녕');

  assert.equal(s.requests[0].auth, 'Bearer k-123');
  assert.equal(s.requests[0].body.stream, true);
  assert.equal(s.requests[0].body.messages[0].role, 'system');
  // 두 번째 요청에는 첫 질문과 답이 들어 있다
  assert.deepEqual(
    s.requests[1].body.messages.slice(1).map((/** @type {any} */ m) => [m.role, m.content]),
    [['user', '안녕?'], ['assistant', '안녕'], ['user', '또 안녕']],
  );

  a.reset?.();
  await collect(a, '새로 시작');
  assert.equal(s.requests[2].body.messages.length, 2); // system + user
  s.close();
});

test('send: HTTP 오류는 error 이벤트가 되고 기록에 남지 않는다', async () => {
  const s = await startServer((_req, _body, res) => {
    res.statusCode = 500;
    res.end('boom');
  });
  const a = createOpenAICompatAdapter({ baseUrl: s.baseUrl, model: 'm' });
  const events = await collect(a, 'x');
  assert.equal(events.at(-1)?.type, 'error');
  assert.match(/** @type {any} */ (events.at(-1)).message, /500/);
  s.close();
});

test('abort: 진행 중인 요청을 끊으면 error 없이 끝난다', async () => {
  const s = await startServer((_req, _body, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'a' } }] })}\n\n`);
    // 끝내지 않고 열어 둔다
  });
  const a = createOpenAICompatAdapter({ baseUrl: s.baseUrl, model: 'm' });
  const events = [];
  for await (const ev of a.send('x')) {
    events.push(ev);
    if (ev.type === 'text') a.abort();
  }
  assert.equal(events.some((e) => e.type === 'error'), false);
  assert.equal(events.some((e) => e.type === 'done'), false);
  s.close();
});
