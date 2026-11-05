// @ts-check
// 저장된 설정 + 환경변수 + 기본값을 합쳐 어댑터/정책이 쓸 실제 값을 만든다.
// 우선순위: 설정 화면에서 저장한 값 > 환경변수 > 기본값
import path from 'node:path';
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
  return {
    defaultWorkDir,
    /** 어댑터 메타 파일(페르소나 등)은 에이전트가 접근하는 작업 폴더 밖에 둔다. */
    metaDir: path.join(userDataDir, 'agent-meta'),

    /** 에이전트가 접근할 수 있는 작업 폴더 */
    workDir() {
      return store.get().permissions.workDir || defaultWorkDir;
    },

    /** 선택한 말투의 내용. 파일이 없으면 기본 말투, 그것도 없으면 빈 문자열(어댑터가 기본 문구를 쓴다). */
    persona() {
      return personas.read(store.get().persona.selected) ?? personas.read(DEFAULT_PERSONA_ID) ?? '';
    },

    policy() {
      const p = store.get().permissions;
      return { autoAllowRead: p.autoAllowRead, workDir: p.workDir || defaultWorkDir };
    },

    claude() {
      const c = store.get().adapters['claude-code'];
      return { path: c.path || env.AIPET_CLAUDE_PATH || '', tools: c.tools, workDir: this.workDir(), persona: this.persona() };
    },

    openai() {
      const c = store.get().adapters['openai-compat'];
      return {
        baseUrl: c.baseUrl || env.AIPET_OPENAI_BASE_URL || DEFAULT_OPENAI_BASE_URL,
        model: c.model || env.AIPET_OPENAI_MODEL || '',
        apiKey: store.getSecret('openaiKey') || env.AIPET_OPENAI_KEY || '',
        persona: this.persona(),
      };
    },

    /** @param {string} id */
    isEnabled(id) {
      return /** @type {any} */ (store.get().adapters)[id]?.enabled !== false;
    },
  };
}
