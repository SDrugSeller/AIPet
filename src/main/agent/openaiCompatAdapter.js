// @ts-check
// OpenAI 호환 어댑터 (Ollama, LM Studio, OpenRouter 등). /chat/completions 스트리밍(SSE)을 AgentEvent로 변환한다.
import { createQueue, PERSONA } from './adapter.js';

const MAX_HISTORY = 20;

/** SSE 스트림을 'data:' 페이로드 문자열로 쪼갠다. @param {ReadableStream<Uint8Array>} body */
export async function* readSseData(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).replace(/\r$/, '');
        buf = buf.slice(i + 1);
        if (line.startsWith('data:')) yield line.slice(5).trim();
      }
    }
    if (buf.startsWith('data:')) yield buf.slice(5).trim();
  } finally {
    reader.releaseLock();
  }
}

/** @param {string} url */
function isHttpUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * @param {{ baseUrl: string, model?: string, apiKey?: string, fetchImpl?: typeof fetch }} opts
 * @returns {import('./adapter.js').AgentAdapter}
 */
export function createOpenAICompatAdapter({ baseUrl, model, apiKey, fetchImpl = fetch }) {
  const base = baseUrl.replace(/\/+$/, '');
  /** @type {string | undefined} */
  let activeModel = model;
  /** @type {{ role: 'user' | 'assistant', content: string }[]} */
  let history = [];
  /** @type {AbortController | null} */
  let controller = null;

  const headers = () => ({
    'Content-Type': 'application/json',
    ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
  });

  return {
    id: 'openai-compat',
    label: 'Ollama / OpenAI 호환',

    async detect() {
      if (!isHttpUrl(base)) return { ok: false, reason: `주소가 올바르지 않아요: ${baseUrl}` };
      try {
        const res = await fetchImpl(`${base}/models`, { headers: headers(), signal: AbortSignal.timeout(3000) });
        if (!res.ok) return { ok: false, reason: `${base} 응답 오류 (HTTP ${res.status})` };
        if (!activeModel) {
          const json = /** @type {any} */ (await res.json());
          activeModel = json?.data?.[0]?.id;
          if (!activeModel) return { ok: false, reason: '사용할 수 있는 모델이 없어요. 예: ollama pull llama3.2' };
        }
        return { ok: true };
      } catch {
        return { ok: false, reason: `${base}에 연결할 수 없어요. Ollama(또는 호환 서버)를 실행해 주세요.` };
      }
    },

    send(msg) {
      const queue = createQueue();
      const ctl = new AbortController();
      controller = ctl;

      (async () => {
        queue.push({ type: 'status', state: 'thinking' });
        const messages = [{ role: 'system', content: PERSONA }, ...history, { role: 'user', content: msg }];
        let reply = '';
        try {
          const res = await fetchImpl(`${base}/chat/completions`, {
            method: 'POST',
            headers: headers(),
            body: JSON.stringify({ model: activeModel, messages, stream: true }),
            signal: ctl.signal,
          });
          if (!res.ok || !res.body) {
            const body = await res.text().catch(() => '');
            queue.push({ type: 'error', message: `요청 실패 (HTTP ${res.status}) ${body.slice(0, 200)}`.trim() });
            return;
          }
          for await (const data of readSseData(res.body)) {
            if (data === '[DONE]') break;
            let delta;
            try {
              delta = JSON.parse(data).choices?.[0]?.delta;
            } catch {
              continue;
            }
            if (delta?.content) {
              reply += delta.content;
              queue.push({ type: 'text', delta: delta.content });
            }
          }
          history = [...history, { role: 'user', content: msg }, { role: 'assistant', content: reply }].slice(-MAX_HISTORY);
          queue.push({ type: 'done' });
        } catch (e) {
          if (!ctl.signal.aborted) queue.push({ type: 'error', message: `연결이 끊어졌어요: ${/** @type {Error} */ (e).message}` });
        } finally {
          if (controller === ctl) controller = null;
          queue.close();
        }
      })();

      return queue;
    },

    respondPermission() {
      // 도구 루프는 M6(API 어댑터)에서 구현
    },

    abort() {
      controller?.abort();
    },

    reset() {
      history = [];
    },
  };
}
