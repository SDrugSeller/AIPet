// @ts-check
// 연결의 "모델" 칸에 보여 줄 "고를 수 있는 모델" 목록을 만든다. 일반 사용자는 모델의 정확한 이름을 모르는 경우가 많아서,
// 직접 입력하는 칸에 목록을 함께 보여 준다. Electron에 의존하지 않는다.
//
// 목록을 얻는 곳은 도구마다 다르다:
//   Codex           `codex debug models` (CLI가 가진 모델 목록. 목록에 보이도록 정해진 것만)
//   OpenAI 호환     서버의 GET /models (Ollama라면 설치된 모델들)
//   Anthropic API   Models API (키가 있어야 한다. 토큰을 쓰지 않는다)
//   Gemini CLI      모델을 물어볼 방법이 없어서 널리 쓰는 모델 이름을 적어 둔다 (직접 입력도 된다)

/** @typedef {{ value: string, label: string }} ModelOption */

/** Codex 모델 목록(`codex debug models` 출력)에서 고를 수 있는 것: visibility가 list인 것을 우선순위 순으로 @param {string} jsonText @returns {ModelOption[]} */
export function parseCodexCatalog(jsonText) {
  try {
    const j = JSON.parse(jsonText);
    const list = Array.isArray(j?.models) ? j.models : Array.isArray(j) ? j : [];
    return list
      .filter((/** @type {any} */ m) => m && typeof m.slug === 'string' && m.visibility === 'list')
      .sort((/** @type {any} */ a, /** @type {any} */ b) => (a.priority ?? 1e9) - (b.priority ?? 1e9))
      .map((/** @type {any} */ m) => ({ value: m.slug, label: typeof m.display_name === 'string' && m.display_name ? m.display_name : m.slug }));
  } catch {
    return [];
  }
}

/** OpenAI 호환 서버의 /models 응답에서 모델 이름들 @param {any} json @returns {ModelOption[]} */
export function parseOpenAIModels(json) {
  const data = Array.isArray(json?.data) ? json.data : [];
  return data.filter((/** @type {any} */ m) => typeof m?.id === 'string' && m.id).map((/** @type {any} */ m) => ({ value: m.id, label: m.id }));
}

/** Anthropic Models API 응답에서 모델들 (새 것이 앞) @param {any} json @returns {ModelOption[]} */
export function parseAnthropicModels(json) {
  const data = Array.isArray(json?.data) ? json.data : Array.isArray(json) ? json : [];
  return data
    .filter((/** @type {any} */ m) => typeof m?.id === 'string' && m.id)
    .map((/** @type {any} */ m) => ({ value: m.id, label: typeof m.display_name === 'string' && m.display_name ? m.display_name : m.id }));
}

/** Gemini CLI: 모델 목록을 물어볼 방법이 없다. 널리 쓰는 이름만 적어 두고, 다른 것은 직접 입력하게 한다. */
export const GEMINI_KNOWN_MODELS = /** @type {ModelOption[]} */ ([
  { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
  { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
  { value: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash-Lite' },
]);
