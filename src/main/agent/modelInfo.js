// @ts-check
// "지금 어떤 모델을 쓰는가"를 알아낸다. 연결의 "모델" 칸을 비워 두면 각 CLI가 알아서 고르는데, 그 값을 사용자에게 보여 주기 위한 것.
// Electron에 의존하지 않고, 파일 읽기와 명령 실행은 바꿔 끼울 수 있게 해서 테스트한다.
//
// 알아내는 방법 (믿을 수 있는 순서):
//   option   이 연결의 "모델" 칸에 적은 값
//   app      API 연결: AIPet이 요청마다 보내는 모델 (칸이 비었으면 앱의 기본 모델)
//   chat     마지막 대화에서 CLI가 알려 준 실제 모델 (Claude Code는 대화 시작 때 모델을 알려 준다)
//   config   CLI의 설정 파일에 적힌 값 (Codex ~/.codex/config.toml, Gemini ~/.gemini/settings.json, Claude ~/.claude/settings.json)
//   catalog  Codex의 모델 목록에서 맨 앞에 보이는 모델 = 기본값으로 추정 (확실하지 않아 "추정"이라고 알린다)
//   default  알 수 없음: CLI가 실행할 때 정한다
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** @typedef {{ name: string, source: 'option' | 'app' | 'chat' | 'config' | 'catalog' | 'default' }} ModelInfo */

const SOURCE_LABEL = {
  option: '이 연결에 지정한 모델',
  app: 'AIPet이 요청에 쓰는 모델',
  chat: '마지막 대화에서 실제로 쓴 모델',
  config: 'CLI 설정 파일 기준',
  catalog: '기본값으로 추정',
  default: 'CLI가 정해요',
};

/**
 * 화면에 보일 한 줄. 이름을 모르면 알 수 없다는 것을 숨기지 않는다.
 * @param {ModelInfo | null | undefined} m @param {{ unknownHint?: string }} [o]
 */
export function describeModel(m, { unknownHint = '실행할 때 CLI가 정해요 (확인할 수 없어요)' } = {}) {
  if (!m || !m.name) return unknownHint;
  return `${m.name} (${SOURCE_LABEL[m.source]})`;
}

/**
 * TOML 파일 맨 위(첫 [표] 앞)의 문자열 값. 필요한 것은 `model = "..."` 한 줄뿐이라 TOML 전체를 읽지 않는다.
 * @param {string} text @param {string} key @returns {string | null}
 */
export function topLevelTomlString(text, key) {
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('[')) break; // 표가 시작되면 맨 위 값은 끝
    const m = line.match(new RegExp(`^${key}\\s*=\\s*(?:"([^"\\n]*)"|'([^'\\n]*)')\\s*(?:#.*)?$`));
    if (m) return (m[1] ?? m[2] ?? '').trim() || null;
  }
  return null;
}

/** Codex의 모델 목록(`codex debug models`)에서 기본값으로 보이는 것: 목록에 보이는(visibility: list) 모델 중 우선순위가 가장 앞선 것 @param {string} jsonText @returns {string | null} */
export function pickCatalogDefault(jsonText) {
  try {
    const j = JSON.parse(jsonText);
    const list = Array.isArray(j?.models) ? j.models : Array.isArray(j) ? j : [];
    const shown = list.filter((/** @type {any} */ m) => m && m.visibility === 'list' && typeof m.slug === 'string');
    shown.sort((/** @type {any} */ a, /** @type {any} */ b) => (a.priority ?? 1e9) - (b.priority ?? 1e9));
    return shown[0]?.slug ?? null;
  } catch {
    return null;
  }
}

/** @param {string} file @param {(p: string) => string} readFile */
function tryRead(file, readFile) {
  try {
    return readFile(file);
  } catch {
    return null;
  }
}

/**
 * Codex가 쓸 모델.
 * @param {{ optionModel?: string, env?: NodeJS.ProcessEnv, readFile?: (p: string) => string, catalog?: () => Promise<string> }} p
 * @returns {Promise<ModelInfo>}
 */
export async function codexModel({ optionModel = '', env = process.env, readFile = (p) => fs.readFileSync(p, 'utf8'), catalog }) {
  if (optionModel) return { name: optionModel, source: 'option' };
  const home = env.CODEX_HOME || path.join(os.homedir(), '.codex');
  const toml = tryRead(path.join(home, 'config.toml'), readFile);
  const fromConfig = toml ? topLevelTomlString(toml, 'model') : null;
  if (fromConfig) return { name: fromConfig, source: 'config' };
  if (catalog) {
    try {
      const guess = pickCatalogDefault(await catalog());
      if (guess) return { name: guess, source: 'catalog' };
    } catch {
      // 목록을 못 읽으면 모른다고 한다
    }
  }
  return { name: '', source: 'default' };
}

/**
 * Gemini CLI가 쓸 모델: 연결 설정 → ~/.gemini/settings.json (model.name 또는 model). 없으면 CLI가 자동으로 고른다.
 * @param {{ optionModel?: string, env?: NodeJS.ProcessEnv, readFile?: (p: string) => string }} p
 * @returns {ModelInfo}
 */
export function geminiModel({ optionModel = '', env = process.env, readFile = (p) => fs.readFileSync(p, 'utf8') }) {
  if (optionModel) return { name: optionModel, source: 'option' };
  if (env.GEMINI_MODEL) return { name: env.GEMINI_MODEL, source: 'config' };
  const text = tryRead(path.join(env.GEMINI_CLI_HOME || os.homedir(), '.gemini', 'settings.json'), readFile);
  if (text) {
    try {
      const j = JSON.parse(text);
      const name = typeof j?.model === 'string' ? j.model : typeof j?.model?.name === 'string' ? j.model.name : '';
      if (name) return { name, source: 'config' };
    } catch {
      // 깨진 설정 파일은 없는 것으로 본다
    }
  }
  return { name: '', source: 'default' };
}

/**
 * Claude Code가 쓸 모델(대화하기 전): 환경변수 ANTHROPIC_MODEL → ~/.claude/settings.json의 model. 없으면 계정에 맞춰 CLI가 정한다.
 * 대화를 시작하면 CLI가 실제 모델을 알려 주므로(source 'chat') 그쪽이 우선한다.
 * @param {{ env?: NodeJS.ProcessEnv, readFile?: (p: string) => string }} p
 * @returns {ModelInfo}
 */
export function claudeModel({ env = process.env, readFile = (p) => fs.readFileSync(p, 'utf8') } = {}) {
  if (env.ANTHROPIC_MODEL) return { name: env.ANTHROPIC_MODEL, source: 'config' };
  const text = tryRead(path.join(env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), 'settings.json'), readFile);
  if (text) {
    try {
      const name = JSON.parse(text)?.model;
      if (typeof name === 'string' && name) return { name, source: 'config' };
    } catch {
      // 깨진 설정 파일은 없는 것으로 본다
    }
  }
  return { name: '', source: 'default' };
}
