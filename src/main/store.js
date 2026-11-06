// @ts-check
// 설정 저장소. JSON 파일 하나에 저장하고, 모르는 키/잘못된 값은 버린다.
// API 키 같은 비밀은 OS 키체인(Electron safeStorage)으로 암호화해서 저장하며, 렌더러에는 절대 보내지 않는다.
import fs from 'node:fs';
import path from 'node:path';
import { isValidConnection, keySecretName, newConnection, validateConnections } from '../shared/connections.js';

/** @typedef {typeof DEFAULTS} Settings */

export const DEFAULTS = {
  version: 2,
  /**
   * 연결 목록. 연결 하나 = AI 계정/서버 하나 = 화면의 캐릭터 하나.
   * 각 연결이 자기 스킨과 말투(말투 파일 이름)를 가진다.
   */
  connections: /** @type {import('../shared/connections.js').Connection[]} */ ([newConnection('claude-code', [])]),
  permissions: {
    /** 읽기 전용 도구(Read/Glob/Grep 등)는 묻지 않고 허용 */
    autoAllowRead: true,
    /**
     * 웹 검색 허용. Claude Code: "웹 검색" 승인 카드를 자동 허용(페이지 가져오기 WebFetch는 계속 묻는다),
     * Codex: 실시간 웹 검색 켜기, Gemini: 검색 허용 안내. 기본은 꺼짐(검색어가 외부로 나가므로).
     */
    autoAllowWeb: false,
    /**
     * 승인 카드를 건너뛰고 자동 허용할 일 (Claude Code 연결의 도구 사용). 모두 기본 꺼짐.
     * 작업 폴더 밖의 경로는 이 설정과 상관없이 거부한다. 자동 허용한 일은 대화창에 흔적이 남는다.
     */
    /** 파일 쓰기/수정 (작업 폴더 안에서만) */
    autoAllowEdit: false,
    /** 명령 실행(Bash/PowerShell). 명령이 건드리는 경로는 검사할 수 없어서 작업 폴더 밖도 건드릴 수 있다 */
    autoAllowShell: false,
    /** 웹 페이지 가져오기(WebFetch). 주소로 정보가 새어 나갈 수 있다 */
    autoAllowFetch: false,
    /**
     * Codex CLI를 `--sandbox workspace-write`로 실행: 작업 폴더 안에서 파일 수정·명령 실행을 묻지 않고 진행한다.
     * Codex는 승인 요청을 앱으로 넘기지 못해서 항목별 선택이나 "묻고 진행"이 불가능하다. 작업 폴더 밖(임시 폴더 제외)
     * 쓰기와 네트워크는 샌드박스가 막는다. 기본 꺼짐(읽기 전용).
     */
    codexWrite: false,
    /** 에이전트가 접근할 수 있는 작업 폴더. 비어 있으면 앱 전용 폴더 */
    workDir: '',
  },
  behavior: {
    /** 활성 창 위에 올라가기 (창의 위치/크기만 읽는다. 제목·내용은 읽지 않는다) */
    sitOnWindows: true,
    /** 전체화면 앱(영상, 게임, 발표)이 활성일 때는 펫을 숨긴다 */
    hideOnFullscreen: true,
  },
  spontaneous: {
    /** 먼저 말 걸기 전체 스위치. 끄면 아래 항목이 모두 동작하지 않는다. (AI를 호출하지 않으므로 토큰은 쓰지 않는다) */
    enabled: true,
    /** 대화창을 닫아 둔 사이 답이 오면 말풍선으로 알려 준다 */
    notifyDone: true,
    /** 오래 쉬지 않고 컴퓨터를 쓰면 쉬라고 말한다 (기본 꺼짐: 먼저 말을 거는 기능은 옵트인) */
    breakReminder: false,
    breakAfterMin: 60,
    breakMessage: '벌써 꽤 오래 쉬지 않았어요. 잠깐 일어나서 스트레칭하는 건 어때요?',
    /** 먼저 말을 거는 사이의 최소 간격(분) */
    cooldownMin: 30,
    /** 정해진 시각의 알림 */
    reminders: /** @type {{ time: string, text: string, enabled: boolean }[]} */ ([]),
  },
  /** 스킨별 크기 조정값 (스킨 폴더 이름 → 프레임 크기/표시 높이). 비어 있으면 skin.json 그대로 */
  skinTuning: /** @type {Record<string, { frameW?: number, frameH?: number, displayH?: number }>} */ ({}),
  general: {
    launchAtLogin: false,
    /** 방해 금지: 먼저 말을 걸지 않고 알림 말풍선도 띄우지 않는다 */
    doNotDisturb: false,
    /** 승인 요청 시 알림음 */
    sound: true,
    /** 펫 표시 여부 (트레이에서 숨김/보이기) */
    visible: true,
  },
};

// --- 검증 ---

/** @param {unknown} v */
const isBool = (v) => typeof v === 'boolean';
/** @param {number} max */
const str = (max) => (/** @type {unknown} */ v) => typeof v === 'string' && v.length <= max;
/** @param {any} v */
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** @param {number} min @param {number} max 정수 범위 */
const int = (min, max) => (/** @type {unknown} */ v) => Number.isInteger(v) && /** @type {number} */ (v) >= min && /** @type {number} */ (v) <= max;
/** 정해진 시각 알림 목록: 최대 20개, 각 항목의 형식이 모두 맞아야 저장한다. @param {unknown} v */
const reminders = (v) =>
  Array.isArray(v) &&
  v.length <= 20 &&
  v.every(
    (r) =>
      isObject(r) &&
      typeof r.time === 'string' &&
      /^([01]\d|2[0-3]):[0-5]\d$/.test(r.time) &&
      typeof r.text === 'string' &&
      r.text.length <= 200 &&
      typeof r.enabled === 'boolean',
  );

/** 스킨별 크기 조정값: 최대 20개 스킨, 각 값은 범위 안의 정수만 허용 @param {unknown} v */
const skinTuning = (v) =>
  isObject(v) &&
  Object.keys(v).length <= 20 &&
  Object.entries(v).every(
    ([id, t]) =>
      /^[A-Za-z0-9_-]{1,64}$/.test(id) &&
      isObject(t) &&
      Object.entries(t).every(([k, n]) => {
        if (k === 'frameW' || k === 'frameH') return int(8, 2048)(n);
        if (k === 'displayH') return int(16, 1024)(n);
        return false; // 모르는 항목은 거부
      }),
  );

/** 키마다 값을 검증하는 함수. 여기 없는 키는 저장하지 않는다. */
const SPEC = {
  connections: validateConnections,
  skinTuning,
  permissions: { autoAllowRead: isBool, autoAllowWeb: isBool, autoAllowEdit: isBool, autoAllowShell: isBool, autoAllowFetch: isBool, codexWrite: isBool, workDir: str(1000) },
  behavior: { sitOnWindows: isBool, hideOnFullscreen: isBool },
  spontaneous: {
    enabled: isBool,
    notifyDone: isBool,
    breakReminder: isBool,
    breakAfterMin: int(5, 600),
    breakMessage: str(200),
    cooldownMin: int(1, 600),
    reminders,
  },
  general: {
    launchAtLogin: isBool,
    doNotDisturb: isBool,
    sound: isBool,
    visible: isBool,
  },
};

/**
 * base에 patch의 유효한 값만 덮어쓴 새 객체를 돌려준다.
 * @param {any} base @param {any} patch @param {any} spec
 */
function merge(base, patch, spec) {
  /** @type {any} */
  const out = {};
  for (const key of Object.keys(base)) {
    const s = spec?.[key];
    const p = isObject(patch) ? patch[key] : undefined;
    if (typeof s === 'function') {
      // 값 하나(또는 통째로 검증하는 레코드/배열)
      out[key] = p !== undefined && s(p) ? structuredClone(p) : base[key];
    } else if (isObject(base[key])) {
      out[key] = merge(base[key], p, s);
    } else {
      out[key] = base[key];
    }
  }
  return out;
}

/** 비밀 항목 이름: 연결별 API 키 ("key:<연결 id>") */
const SECRET_NAME_RE = /^key:[a-z0-9][a-z0-9-]{0,31}$/;

/**
 * 예전 형식(v1: backend/adapters/persona/general.skin)의 설정을 연결 목록으로 옮긴다.
 *  - Claude Code 연결 1개는 항상 만든다 (예전에도 기본으로 있던 연결)
 *  - Ollama/OpenAI 호환은 사용자가 주소/모델/키를 설정해 둔 경우에만 만든다 (아니면 안 쓰던 연결이 캐릭터로 생긴다)
 * @param {any} raw
 * @returns {{ connections: import('../shared/connections.js').Connection[], secrets: Record<string, string> } | null}
 */
function migrateLegacy(raw) {
  if (!(raw.adapters || raw.general?.skin || raw.persona || raw.backend)) return null;
  const skin = typeof raw.general?.skin === 'string' ? raw.general.skin : 'default';
  const persona = typeof raw.persona?.selected === 'string' ? raw.persona.selected : '기본.txt';
  const a = isObject(raw.adapters) ? raw.adapters : {};

  /** @type {import('../shared/connections.js').Connection[]} */
  const list = [];
  const claude = a['claude-code'] ?? {};
  list.push({
    id: 'claude-code',
    name: 'Claude Code',
    kind: 'claude-code',
    enabled: claude.enabled !== false,
    skin,
    persona,
    options: { path: typeof claude.path === 'string' ? claude.path : '', configDir: '', tools: claude.tools !== false },
  });

  /** @type {Record<string, string>} */
  const secrets = {};
  const o = a['openai-compat'];
  const oldKey = raw.secrets?.openaiKey;
  if (o && (o.baseUrl || o.model || oldKey)) {
    list.push({
      id: 'openai-compat',
      name: 'Ollama / OpenAI 호환',
      kind: 'openai-compat',
      enabled: o.enabled !== false,
      skin: 'default',
      persona,
      options: { baseUrl: typeof o.baseUrl === 'string' ? o.baseUrl : '', model: typeof o.model === 'string' ? o.model : '' },
    });
    if (typeof oldKey === 'string') secrets[keySecretName('openai-compat')] = oldKey;
  }
  return { connections: list.filter(isValidConnection), secrets };
}

/**
 * @param {{
 *   file: string,
 *   safeStorage: { isEncryptionAvailable(): boolean, encryptString(s: string): Buffer, decryptString(b: Buffer): string },
 * }} opts
 */
export function createStore({ file, safeStorage }) {
  /** @type {Record<string, string>} 암호화된(base64) 비밀 */
  let secrets = {};
  /** @type {Settings} */
  let data = structuredClone(DEFAULTS);
  /** @type {Set<(s: Settings) => void>} */
  const listeners = new Set();
  let migrated = false;

  try {
    // 메모장 등 Windows 편집기는 UTF-8 BOM을 붙여 저장하므로, BOM이 있어도 읽을 수 있어야 한다.
    const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    if (raw.connections === undefined) {
      const legacy = migrateLegacy(raw);
      if (legacy) {
        raw.connections = legacy.connections;
        secrets = { ...legacy.secrets };
        migrated = true;
      }
    }
    data = merge(DEFAULTS, raw, SPEC);
    if (isObject(raw.secrets)) {
      for (const [n, v] of Object.entries(raw.secrets)) {
        if (SECRET_NAME_RE.test(n) && typeof v === 'string') secrets[n] = v;
      }
    }
  } catch (e) {
    // 파일이 없으면 기본값. 깨진 파일은 덮어쓰기 전에 보존해 둔다.
    if (/** @type {NodeJS.ErrnoException} */ (e).code !== 'ENOENT') {
      try {
        fs.renameSync(file, `${file}.broken`);
      } catch {
        // 보존 실패는 무시
      }
    }
  }

  function save() {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ ...data, secrets }, null, 2), 'utf8');
    fs.renameSync(tmp, file); // 쓰는 도중 꺼져도 기존 파일이 깨지지 않게
  }

  if (migrated) save(); // 새 형식으로 바로 저장해 두 번 옮기지 않게

  function notify() {
    for (const cb of listeners) cb(structuredClone(data));
  }

  return {
    /** 현재 설정의 복사본 (비밀 제외) */
    get() {
      return structuredClone(data);
    },

    /** 일부만 바꾼다. 유효하지 않은 값은 무시된다. @param {any} patch */
    update(patch) {
      data = merge(data, patch, SPEC);
      // 지워진 연결의 API 키는 같이 지운다 (쓰지 않는 비밀이 남지 않게)
      const alive = new Set(data.connections.map((c) => keySecretName(c.id)));
      for (const n of Object.keys(secrets)) if (!alive.has(n)) delete secrets[n];
      save();
      notify();
      return structuredClone(data);
    },

    /** @param {string} name */
    hasSecret(name) {
      return !!secrets[name];
    },

    /** @param {string} name @returns {string | null} */
    getSecret(name) {
      if (!secrets[name]) return null;
      try {
        return safeStorage.decryptString(Buffer.from(secrets[name], 'base64'));
      } catch {
        return null; // 다른 PC/계정에서 복사된 파일 등
      }
    },

    /** 값이 빈 문자열/null이면 삭제 @param {string} name @param {string | null} value @returns {{ ok: boolean, reason?: string }} */
    setSecret(name, value) {
      if (!SECRET_NAME_RE.test(name)) return { ok: false, reason: '알 수 없는 항목이에요' };
      if (!value) {
        delete secrets[name];
      } else {
        if (!data.connections.some((c) => keySecretName(c.id) === name)) return { ok: false, reason: '없는 연결이에요' };
        if (!safeStorage.isEncryptionAvailable()) {
          return { ok: false, reason: 'OS 보안 저장소를 쓸 수 없어 키를 저장하지 않았어요 (환경변수를 사용해 주세요)' };
        }
        secrets[name] = safeStorage.encryptString(value.slice(0, 500)).toString('base64');
      }
      save();
      notify();
      return { ok: true };
    },

    /** @param {(s: Settings) => void} cb */
    onChange(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
  };
}
