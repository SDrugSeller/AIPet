// @ts-check
// Anthropic API 어댑터. 사용자가 입력한 API 키로 공식 SDK(@anthropic-ai/sdk)를 통해 Messages API를 스트리밍으로 호출한다.
// 대화 전용이다 (도구 없음). 키는 설정의 보안 저장소(또는 ANTHROPIC_API_KEY 환경변수)에서만 가져온다.
import Anthropic from '@anthropic-ai/sdk';
import { buildSystemPrompt, createQueue } from './adapter.js';

const MAX_HISTORY = 20;

/**
 * 서버 측 거절 대체(fallbacks)를 지원하는 모델. 안전 분류기가 요청을 거절하면 API가 같은 요청을 다른 모델로 다시 처리해 준다.
 * (베타 헤더 server-side-fallback-2026-07-01, fallbacks: "default")
 * @param {string} model
 */
const supportsFallbacks = (model) => /^claude-(opus-5|fable-5|sonnet-5-5)/.test(model);

/** SDK 오류를 사용자가 이해할 문장으로 바꾼다. @param {unknown} e */
export function friendlyAnthropicError(e) {
  if (e instanceof Anthropic.AuthenticationError || e instanceof Anthropic.PermissionDeniedError) {
    return 'Anthropic API 키가 올바르지 않거나 권한이 없어요. 설정에서 키를 확인해 주세요.';
  }
  if (e instanceof Anthropic.NotFoundError) return '모델을 찾을 수 없어요. 모델 이름을 확인해 주세요.';
  if (e instanceof Anthropic.RateLimitError) return '요청이 너무 많거나 한도에 걸렸어요. 잠시 뒤에 다시 시도해 주세요.';
  if (e instanceof Anthropic.BadRequestError) return `요청이 거절됐어요: ${e.message}`;
  if (e instanceof Anthropic.APIConnectionError) return 'Anthropic API에 연결할 수 없어요. 인터넷 연결을 확인해 주세요.';
  if (e instanceof Anthropic.APIError) return `Anthropic API 오류 (${e.status ?? '?'}): ${e.message}`;
  return `연결이 끊어졌어요: ${/** @type {Error} */ (e)?.message ?? e}`;
}

/**
 * @param {{
 *   getConfig: () => { model: string, apiKey?: string, baseUrl?: string, persona?: string },
 *   clientOptions?: ConstructorParameters<typeof Anthropic>[0],
 * }} opts
 *   clientOptions: 테스트에서 가짜 서버 주소 등을 주입하기 위한 SDK 옵션
 * @returns {import('./adapter.js').AgentAdapter}
 */
export function createAnthropicApiAdapter({ getConfig, clientOptions }) {
  /** @type {{ role: 'user' | 'assistant', content: string }[]} */
  let history = [];
  /** @type {{ abort: () => void } | null} */
  let stream = null;
  let aborted = false;

  /** 설정은 호출할 때마다 읽는다 (설정 창에서 바꾸면 바로 반영). 키가 비어 있으면 SDK가 환경변수/프로필에서 찾는다. */
  function client() {
    const cfg = getConfig();
    return new Anthropic({ apiKey: cfg.apiKey || undefined, baseURL: cfg.baseUrl || undefined, ...clientOptions });
  }

  return {
    id: 'anthropic-api',
    label: 'Anthropic API',

    async detect() {
      const cfg = getConfig();
      if (!cfg.apiKey && !process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
        return { ok: false, reason: 'API 키가 없어요. 설정에서 Anthropic API 키를 입력해 주세요. (토큰을 쓰지 않는 확인 요청만 보내요)' };
      }
      try {
        // 모델 조회는 토큰을 쓰지 않는다. 키와 모델 이름이 맞는지 한 번에 확인된다.
        const m = await client().models.retrieve(cfg.model, { timeout: 10_000, maxRetries: 0 });
        return { ok: true, info: `모델: ${m.display_name ?? cfg.model} (${cfg.model})\n키: ${cfg.apiKey ? '설정에 저장된 키' : '환경변수'}` };
      } catch (e) {
        return { ok: false, reason: friendlyAnthropicError(e) };
      }
    },

    send(msg) {
      const queue = createQueue();
      aborted = false;

      (async () => {
        const cfg = getConfig();
        queue.push({ type: 'status', state: 'thinking' });
        let reply = '';
        try {
          /** @type {any} */
          const params = {
            model: cfg.model,
            max_tokens: 16000,
            system: buildSystemPrompt(cfg.persona, false),
            messages: [...history, { role: 'user', content: msg }],
          };
          const c = client();
          // 안전 분류기가 요청을 거절하면 서버가 같은 요청을 대체 모델로 다시 처리하게 한다 (지원하는 모델에서만).
          const s = supportsFallbacks(cfg.model)
            ? c.beta.messages.stream({ ...params, betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' })
            : c.messages.stream(params);
          stream = s;

          for await (const event of s) {
            if (event.type === 'content_block_start' && event.content_block.type === 'thinking') {
              queue.push({ type: 'status', state: 'thinking' });
            } else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta' && event.delta.text) {
              reply += event.delta.text;
              queue.push({ type: 'text', delta: event.delta.text });
            }
          }
          const final = await s.finalMessage();
          if (final.stop_reason === 'refusal') {
            queue.push({ type: 'error', message: '안전 정책 때문에 이 요청에는 답할 수 없어요.' });
          } else {
            history = [...history, { role: 'user', content: msg }, { role: 'assistant', content: reply }].slice(-MAX_HISTORY);
            queue.push({ type: 'done' });
          }
        } catch (e) {
          if (!aborted) queue.push({ type: 'error', message: friendlyAnthropicError(e) });
        } finally {
          stream = null;
          queue.close();
        }
      })();

      return queue;
    },

    respondPermission() {
      // 도구가 없는 어댑터라 권한 요청이 발생하지 않는다.
    },

    abort() {
      aborted = true;
      stream?.abort();
    },

    reset() {
      history = [];
    },
  };
}
