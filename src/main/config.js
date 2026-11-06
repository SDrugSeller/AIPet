// @ts-check
// 저장된 설정 + 환경변수 + 기본값을 합쳐 어댑터/정책이 쓸 실제 값을 만든다.
// 우선순위: 설정 화면에서 저장한 값 > 환경변수 > 기본값
// 연결(connection)마다 값이 다르므로 대부분의 함수가 연결 id를 받는다.
import path from 'node:path';
import { keySecretName } from '../shared/connections.js';
import { DEFAULT_PERSONA_ID } from './personas.js';

export const DEFAULT_OPENAI_BASE_URL = 'http://127.0.0.1:11434/v1';

/**
 * @param {{
 *   store: ReturnType<typeof import('./store.js').createStore>,
 *   personas: ReturnType<typeof import('./personas.js').createPersonaStore>,
 *   userDataDir: string,
 *   env?: NodeJS.ProcessEnv,
 * }} opts
 */
export function createConfig({ store, personas, userDataDir, env = process.env }) {
  const defaultWorkDir = path.join(userDataDir, 'agent-workspace');
  const metaRoot = path.join(userDataDir, 'agent-meta');

  /** @param {string} id */
  const conn = (id) => {
    const c = store.get().connections.find((x) => x.id === id);
    if (!c) throw new Error(`없는 연결: ${id}`);
    return c;
  };
  /** @param {string} id @param {string} key */
  const opt = (id, key) => String(conn(id).options[key] ?? '');
  /** 이 연결의 말투 내용. 파일이 없으면 기본 말투, 그것도 없으면 빈 문자열(어댑터가 기본 문구를 쓴다). @param {string} id */
  const persona = (id) => personas.read(conn(id).persona) ?? personas.read(DEFAULT_PERSONA_ID) ?? '';

  return {
    defaultWorkDir,
    /** 어댑터 메타 파일(시스템 프롬프트 등)은 에이전트가 접근하는 작업 폴더 밖에 둔다. 연결마다 따로 쓴다. @param {string} id */
    metaDir: (id) => path.join(metaRoot, id),

    /** 에이전트가 접근할 수 있는 작업 폴더 */
    workDir() {
      return store.get().permissions.workDir || defaultWorkDir;
    },

    policy() {
      const p = store.get().permissions;
      return { autoAllowRead: p.autoAllowRead, autoAllowWeb: p.autoAllowWeb, workDir: p.workDir || defaultWorkDir };
    },

    /** @param {string} id */
    connection: conn,

    /** @param {string} id */
    persona,

    /** @param {string} id */
    claude(id) {
      return {
        path: opt(id, 'path') || env.AIPET_CLAUDE_PATH || '',
        configDir: opt(id, 'configDir'),
        tools: conn(id).options.tools !== false,
        workDir: this.workDir(),
        persona: persona(id),
      };
    },

    /** @param {string} id */
    codex(id) {
      return { path: opt(id, 'path'), model: opt(id, 'model'), workDir: this.workDir(), persona: persona(id), web: store.get().permissions.autoAllowWeb };
    },

    /** @param {string} id */
    gemini(id) {
      return { path: opt(id, 'path'), model: opt(id, 'model'), workDir: this.workDir(), persona: persona(id), web: store.get().permissions.autoAllowWeb };
    },

    /** @param {string} id */
    anthropic(id) {
      return {
        model: opt(id, 'model') || 'claude-opus-5-5',
        baseUrl: opt(id, 'baseUrl'),
        apiKey: store.getSecret(keySecretName(id)) || '',
        persona: persona(id),
      };
    },

    /** @param {string} id */
    openai(id) {
      return {
        baseUrl: opt(id, 'baseUrl') || env.AIPET_OPENAI_BASE_URL || DEFAULT_OPENAI_BASE_URL,
        model: opt(id, 'model') || env.AIPET_OPENAI_MODEL || '',
        apiKey: store.getSecret(keySecretName(id)) || env.AIPET_OPENAI_KEY || '',
        persona: persona(id),
      };
    },
  };
}
