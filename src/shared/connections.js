// @ts-check
// "연결(connection)": 펫 하나가 대화하는 상대(AI 계정/서버)의 설정. 연결 하나가 캐릭터 하나가 된다.
// main(검증/어댑터 생성)과 설정 창(종류별 입력칸, 기본값)이 같은 정의를 쓰도록 공용 모듈로 둔다.

/** 한 번에 둘 수 있는 연결(캐릭터) 수. 화면이 어수선해지고 프로세스가 늘어나는 것을 막는다. */
export const MAX_CONNECTIONS = 8;

/**
 * @typedef {'claude-code' | 'codex-cli' | 'gemini-cli' | 'anthropic-api' | 'openai-compat'} Kind
 * @typedef {{
 *   id: string, name: string, kind: Kind, enabled: boolean, skin: string, persona: string,
 *   options: Record<string, string | boolean>,
 * }} Connection
 *
 * 옵션 항목: 'str' 문자열, 'bool' 참/거짓, 'url' 빈 문자열이거나 http(s) 주소
 * tools: 이 종류가 파일/명령 도구를 쓸 수 있는가 (쓸 수 있으면 권한 승인 카드가 뜬다)
 * @type {Record<Kind, { label: string, tools: boolean, optionTypes: Record<string, 'str' | 'bool' | 'url'>, defaults: Record<string, string | boolean> }>}
 */
export const KINDS = {
  'claude-code': {
    label: 'Claude Code',
    tools: true,
    optionTypes: { path: 'str', configDir: 'str', tools: 'bool' },
    defaults: { path: '', configDir: '', tools: true },
  },
  'codex-cli': {
    label: 'Codex CLI',
    tools: false,
    optionTypes: { path: 'str', model: 'str' },
    defaults: { path: '', model: '' },
  },
  'gemini-cli': {
    label: 'Gemini CLI',
    tools: false,
    optionTypes: { path: 'str', model: 'str' },
    defaults: { path: '', model: '' },
  },
  'anthropic-api': {
    label: 'Anthropic API',
    tools: false,
    optionTypes: { model: 'str', baseUrl: 'url' },
    defaults: { model: 'claude-opus-5-5', baseUrl: '' },
  },
  'openai-compat': {
    label: 'Ollama / OpenAI 호환',
    tools: false,
    optionTypes: { baseUrl: 'url', model: 'str' },
    defaults: { baseUrl: '', model: '' },
  },
};

export const KIND_IDS = /** @type {Kind[]} */ (Object.keys(KINDS));

const ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const SKIN_RE = /^[A-Za-z0-9_-]{1,64}$/;
const PERSONA_RE = /^[^\\/:*?"<>|]{1,60}\.txt$/;

/** @param {unknown} v */
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** @param {unknown} v */
function isHttpUrlOrEmpty(v) {
  if (v === '') return true;
  if (typeof v !== 'string' || v.length > 500) return false;
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

/** 연결 하나가 형식에 맞는가 (모르는 옵션 키가 있으면 거부) @param {unknown} c */
export function isValidConnection(c) {
  if (!isObject(c)) return false;
  const x = /** @type {Record<string, any>} */ (c);
  if (typeof x.id !== 'string' || !ID_RE.test(x.id)) return false;
  if (typeof x.name !== 'string' || x.name.trim().length < 1 || x.name.length > 40) return false;
  if (typeof x.kind !== 'string' || !(x.kind in KINDS)) return false;
  if (typeof x.enabled !== 'boolean') return false;
  if (typeof x.skin !== 'string' || !SKIN_RE.test(x.skin)) return false;
  if (typeof x.persona !== 'string' || !PERSONA_RE.test(x.persona) || x.persona.includes('..')) return false;
  if (!isObject(x.options)) return false;
  const types = KINDS[/** @type {Kind} */ (x.kind)].optionTypes;
  for (const [k, v] of Object.entries(x.options)) {
    const t = types[k];
    if (t === 'bool' && typeof v !== 'boolean') return false;
    if (t === 'str' && !(typeof v === 'string' && v.length <= 1000)) return false;
    if (t === 'url' && !isHttpUrlOrEmpty(v)) return false;
    if (!t) return false;
  }
  return true;
}

/** 연결 목록 전체 검증: 개수 제한, 각 연결의 형식, id 중복 없음 @param {unknown} v */
export function validateConnections(v) {
  if (!Array.isArray(v) || v.length > MAX_CONNECTIONS) return false;
  const ids = new Set();
  for (const c of v) {
    if (!isValidConnection(c) || ids.has(c.id)) return false;
    ids.add(c.id);
  }
  return true;
}

/**
 * 새 연결을 만든다. id는 종류 이름에서 따고, 겹치면 번호를 붙인다.
 * @param {Kind} kind @param {{ id: string, name?: string }[]} existing
 * @param {{ skin?: string, persona?: string }} [pick]
 * @returns {Connection}
 */
export function newConnection(kind, existing, pick = {}) {
  const ids = new Set(existing.map((c) => c.id));
  const names = new Set(existing.map((c) => c.name));
  let id = kind;
  for (let n = 2; ids.has(id); n++) id = `${kind}-${n}`;
  const base = KINDS[kind].label;
  let name = base;
  for (let n = 2; names.has(name); n++) name = `${base} ${n}`;
  return {
    id,
    name,
    kind,
    enabled: true,
    skin: pick.skin ?? 'default',
    persona: pick.persona ?? '기본.txt',
    options: { ...KINDS[kind].defaults },
  };
}

/** API 키를 저장하는 비밀 항목 이름 @param {string} connectionId */
export const keySecretName = (connectionId) => `key:${connectionId}`;
