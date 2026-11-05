// @ts-check
// OpenAI 호환 어댑터 (Ollama, LM Studio, OpenRouter 등). /chat/completions 스트리밍(SSE)을 AgentEvent로 변환한다.
// 이 어댑터에는 도구 루프가 없다 (대화 전용). 도구는 API 어댑터(M6)에서 앱이 직접 게이트하며 구현한다.
import { buildSystemPrompt, createQueue } from './adapter.js';

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
 * 설정은 호출할 때마다 getConfig()로 읽는다 (설정 화면에서 바꾸면 바로 반영).
 * @param {{
 *   getConfig: () => { baseUrl: string, model?: string, apiKey?: string, persona?: string },
 *   fetchImpl?: typeof fetch,
 * }} opts
 * @returns {import('./adapter.js').AgentAdapter}
 */
export function createOpenAICompatAdapter({ getConfig, fetchImpl = fetch }) {
  /** 모델을 지정하지 않았을 때 서버에서 찾은 첫 모델 (주소별로 기억) @type {Map<string, string>} */
  const detectedModels = new Map();
  /** @type {{ role: 'user' | 'assistant', content: string }[]} */
  let history = [];
  /** @type {AbortController | null} */
  let controller = null;

  const baseOf = () => getConfig().baseUrl.replace(/\/+$/, '');

  const headers = () => {
    const { apiKey } = getConfig();
    return { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) };
  };

  /** 쓸 모델 이름. 지정이 없으면 서버의 첫 모델. @returns {Promise<string | undefined>} */
  async function resolveModel() {
    const base = baseOf();
    const { model } = getConfig();
    if (model) return model;
    if (detectedModels.has(base)) return detectedModels.get(base);
    const res = await fetchImpl(`${base}/models`, { headers: headers(), signal: AbortSignal.timeout(3000) });
    const id = res.ok ? /** @type {any} */ (await res.json())?.data?.[0]?.id : undefined;
    if (id) detectedModels.set(base, id);
    return id;
  }

  return {
    id: 'openai-compat',
    label: 'Ollama / OpenAI 호환',

    async detect() {
      const base = baseOf();
      if (!isHttpUrl(base)) return { ok: false, reason: `주소가 올바르지 않아요: ${base}` };
      try {
        const res = await fetchImpl(`${base}/models`, { headers: headers(), signal: AbortSignal.timeout(3000) });
        if (!res.ok) return { ok: false, reason: `${base} 응답 오류 (HTTP ${res.status})` };
        const cfg = getConfig();
        let model = cfg.model;
        if (!model) {
          model = /** @type {any} */ (await res.json())?.data?.[0]?.id;
          if (!model) return { ok: false, reason: '사용할 수 있는 모델이 없어요. 예: ollama pull llama3.2' };
          detectedModels.set(base, model);
        }
        return { ok: true, info: `${base}\n모델: ${model} · API 키: ${cfg.apiKey ? '사용' : '없음'}` };
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
        const base = baseOf();
        const messages = [{ role: 'system', content: buildSystemPrompt(getConfig().persona, false) }, ...history, { role: 'user', content: msg }];
        let reply = '';
        try {
          const model = await resolveModel();
          const res = await fetchImpl(`${base}/chat/completions`, {
            method: 'POST',
            headers: headers(),
            body: JSON.stringify({ model, messages, stream: true }),
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
      // 도구가 없는 어댑터라 권한 요청이 발생하지 않는다.
    },

    abort() {
      controller?.abort();
    },

    reset() {
      history = [];
    },
  };
}
