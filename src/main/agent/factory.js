// @ts-check
// 연결(connection)의 종류에 맞는 어댑터를 만든다. 설정은 어댑터가 호출할 때마다 config에서 읽으므로
// 설정 창에서 바꾸면 바로 반영된다.
import { createAnthropicApiAdapter } from './anthropicApiAdapter.js';
import { createClaudeCodeAdapter } from './claudeCodeAdapter.js';
import { createCodexCliAdapter } from './codexCliAdapter.js';
import { createGeminiCliAdapter } from './geminiCliAdapter.js';
import { createOpenAICompatAdapter } from './openaiCompatAdapter.js';

/**
 * @param {import('../../shared/connections.js').Connection} conn
 * @param {{ config: ReturnType<typeof import('../config.js').createConfig>, metaDir: (id: string) => string }} deps
 * @returns {import('./adapter.js').AgentAdapter}
 */
export function createAdapterFor(conn, { config, metaDir }) {
  const id = conn.id;
  switch (conn.kind) {
    case 'claude-code':
      return createClaudeCodeAdapter({ getConfig: () => config.claude(id), metaDir: metaDir(id) });
    case 'codex-cli':
      return createCodexCliAdapter({ getConfig: () => config.codex(id) });
    case 'gemini-cli':
      return createGeminiCliAdapter({ getConfig: () => config.gemini(id) });
    case 'anthropic-api':
      return createAnthropicApiAdapter({ getConfig: () => config.anthropic(id) });
    case 'openai-compat':
      return createOpenAICompatAdapter({ getConfig: () => config.openai(id) });
    default:
      throw new Error(`알 수 없는 연결 종류: ${/** @type {any} */ (conn).kind}`);
  }
}
