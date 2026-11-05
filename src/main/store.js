// @ts-check
// 설정 저장소. JSON 파일 하나에 저장하고, 모르는 키/잘못된 값은 버린다.
// API 키 같은 비밀은 OS 키체인(Electron safeStorage)으로 암호화해서 저장하며, 렌더러에는 절대 보내지 않는다.
import fs from 'node:fs';
import path from 'node:path';

/** @typedef {typeof DEFAULTS} Settings */

export const DEFAULTS = {
  version: 1,
  backend: {
    /** @type {string | null} 마지막으로 고른 AI 연결 */
    selected: /** @type {string | null} */ (null),
  },
  adapters: {
    'claude-code': {
      enabled: true,
      /** 비어 있으면 자동 탐지 */
      path: '',
      /** 파일/명령 도구 사용 허용 (모든 위험한 동작은 승인 후 실행) */
      tools: true,
    },
    'openai-compat': {
      enabled: true,
      /** 비어 있으면 Ollama 기본 주소 */
      baseUrl: '',
      /** 비어 있으면 서버의 첫 모델 */
      model: '',
    },
  },
  persona: {
    /** 말투 파일 이름 (userData/personas/*.txt) */
    selected: '기본.txt',
  },
  permissions: {
    /** 읽기 전용 도구(Read/Glob/Grep 등)는 묻지 않고 허용 */
    autoAllowRead: true,
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
  general: {
    /** 펫 스킨 폴더 이름 (바꾸면 앱이 다시 시작된다) */
    skin: 'default',
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
/** 빈 문자열이거나 http(s) 주소 @param {unknown} v */
const httpUrlOrEmpty = (v) => {
  if (v === '') return true;
  if (typeof v !== 'string' || v.length > 500) return false;
  try {
    const u = new URL(v);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
};

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

/** 키마다 값을 검증하는 함수. 여기 없는 키는 저장하지 않는다. */
const SPEC = {
  backend: { selected: (/** @type {unknown} */ v) => v === null || (typeof v === 'string' && v.length <= 64) },
  adapters: {
    'claude-code': { enabled: isBool, path: str(1000), tools: isBool },
    'openai-compat': { enabled: isBool, baseUrl: httpUrlOrEmpty, model: str(200) },
  },
  persona: { selected: (/** @type {unknown} */ v) => typeof v === 'string' && /^[^\\/:*?"<>|]{1,60}\.txt$/.test(v) && !v.includes('..') },
  permissions: { autoAllowRead: isBool, workDir: str(1000) },
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
    skin: (/** @type {unknown} */ v) => typeof v === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(v),
    launchAtLogin: isBool,
    doNotDisturb: isBool,
    sound: isBool,
    visible: isBool,
  },
};

/** @param {any} v */
const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

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
    if (isObject(base[key])) {
      out[key] = merge(base[key], p, s);
    } else if (typeof s === 'function' && p !== undefined && s(p)) {
      out[key] = p;
    } else {
      out[key] = base[key];
    }
  }
  return out;
}

const SECRET_NAMES = ['openaiKey'];

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

  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    data = merge(DEFAULTS, raw, SPEC);
    if (isObject(raw.secrets)) {
      for (const n of SECRET_NAMES) if (typeof raw.secrets[n] === 'string') secrets[n] = raw.secrets[n];
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
      if (!SECRET_NAMES.includes(name)) return { ok: false, reason: '알 수 없는 항목이에요' };
      if (!value) {
        delete secrets[name];
      } else {
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
