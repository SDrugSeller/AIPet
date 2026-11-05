// @ts-check
// 저장된 설정 + 환경변수 + 기본값을 합쳐 어댑터/정책이 쓸 실제 값을 만든다.
// 우선순위: 설정 화면에서 저장한 값 > 환경변수 > 기본값
import path from 'node:path';

export const DEFAULT_OPENAI_BASE_URL = 'http://127.0.0.1:11434/v1';

/**
 * @param {{ store: ReturnType<typeof import('./store.js').createStore>, userDataDir: string, env?: NodeJS.ProcessEnv }} opts
 */
export function createConfig({ store, userDataDir, env = process.env }) {
  const defaultWorkDir = path.join(userDataDir, 'agent-workspace');
  return {
    defaultWorkDir,
    /** 어댑터 메타 파일(페르소나 등)은 에이전트가 접근하는 작업 폴더 밖에 둔다. */
    metaDir: path.join(userDataDir, 'agent-meta'),

    /** 에이전트가 접근할 수 있는 작업 폴더 */
    workDir() {
      return store.get().permissions.workDir || defaultWorkDir;
    },

    policy() {
      const p = store.get().permissions;
      return { autoAllowRead: p.autoAllowRead, workDir: p.workDir || defaultWorkDir };
    },

    claude() {
      const c = store.get().adapters['claude-code'];
      return { path: c.path || env.AIPET_CLAUDE_PATH || '', tools: c.tools, workDir: this.workDir() };
    },

    openai() {
      const c = store.get().adapters['openai-compat'];
      return {
        baseUrl: c.baseUrl || env.AIPET_OPENAI_BASE_URL || DEFAULT_OPENAI_BASE_URL,
        model: c.model || env.AIPET_OPENAI_MODEL || '',
        apiKey: store.getSecret('openaiKey') || env.AIPET_OPENAI_KEY || '',
      };
    },

    /** @param {string} id */
    isEnabled(id) {
      return /** @type {any} */ (store.get().adapters)[id]?.enabled !== false;
    },
  };
}
