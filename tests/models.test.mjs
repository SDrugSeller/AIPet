// @ts-check
import assert from 'node:assert/strict';
import test from 'node:test';
import { translateClaudeMessage } from '../src/main/agent/claudeCodeAdapter.js';
import { translateGeminiLine } from '../src/main/agent/geminiCliAdapter.js';
import { claudeModel, codexModel, describeModel, geminiModel, pickCatalogDefault, topLevelTomlString } from '../src/main/agent/modelInfo.js';
import { CLAUDE_KNOWN_MODELS, GEMINI_KNOWN_MODELS, parseAnthropicModels, parseCodexCatalog, parseOpenAIModels } from '../src/main/agent/modelList.js';

const CATALOG = JSON.stringify({
  models: [
    { slug: 'gpt-reserve', display_name: 'GPT-Reserve', visibility: 'hide', priority: 1 },
    { slug: 'gpt-6-luna', display_name: 'GPT-6-Luna', visibility: 'list', priority: 2 },
    { slug: 'gpt-5.6-terra', display_name: 'GPT-5.6-Terra', visibility: 'list', priority: 3 },
    { slug: 'codex-auto-review', display_name: 'Codex Auto Review', visibility: 'hide', priority: 5 },
  ],
});

test('topLevelTomlString: 맨 위의 model 값만 읽고, 표 안의 값과 주석은 무시한다', () => {
  assert.equal(topLevelTomlString('model = "gpt-6-luna"\nmodel_reasoning_effort = "medium"\n', 'model'), 'gpt-6-luna');
  assert.equal(topLevelTomlString("model = 'x'  # 주석\n", 'model'), 'x');
  assert.equal(topLevelTomlString('[profile.a]\nmodel = "inner"\n', 'model'), null, '표가 시작된 뒤는 맨 위 값이 아니다');
  assert.equal(topLevelTomlString('# model = "no"\nother = 1\n', 'model'), null);
  assert.equal(topLevelTomlString('model = ""\n', 'model'), null);
  assert.equal(topLevelTomlString('model_provider = "openai"\n', 'model'), null, '이름이 model로 시작하는 다른 키와 헷갈리지 않는다');
});

test('Codex 모델 목록: 보이는 모델만 우선순위 순으로, 기본값 추정은 그 맨 앞', () => {
  assert.deepEqual(parseCodexCatalog(CATALOG), [
    { value: 'gpt-6-luna', label: 'GPT-6-Luna' },
    { value: 'gpt-5.6-terra', label: 'GPT-5.6-Terra' },
  ]);
  assert.equal(pickCatalogDefault(CATALOG), 'gpt-6-luna');
  assert.deepEqual(parseCodexCatalog('not json'), []);
  assert.equal(pickCatalogDefault('{}'), null);
});

test('codexModel: 연결 설정 → Codex 설정 파일 → 목록에서 추정 → 알 수 없음 순서로 알아낸다', async () => {
  const withConfig = { env: { CODEX_HOME: 'X' }, readFile: () => 'model = "from-config"\n', catalog: async () => CATALOG };
  assert.deepEqual(await codexModel({ optionModel: 'mine', ...withConfig }), { name: 'mine', source: 'option' });
  assert.deepEqual(await codexModel(withConfig), { name: 'from-config', source: 'config' });
  const noFile = { env: { CODEX_HOME: 'X' }, readFile: () => { throw new Error('없음'); } };
  assert.deepEqual(await codexModel({ ...noFile, catalog: async () => CATALOG }), { name: 'gpt-6-luna', source: 'catalog' });
  assert.deepEqual(await codexModel({ ...noFile, catalog: async () => { throw new Error('실패'); } }), { name: '', source: 'default' });
  assert.deepEqual(await codexModel(noFile), { name: '', source: 'default' });
});

test('geminiModel / claudeModel: 설정 파일과 환경변수에서 알아내고, 없으면 모른다고 한다', () => {
  const read = (/** @type {string} */ text) => () => text;
  assert.deepEqual(geminiModel({ optionModel: 'g', readFile: read('{}') }), { name: 'g', source: 'option' });
  assert.deepEqual(geminiModel({ env: {}, readFile: read('{"model":{"name":"gemini-2.5-pro"}}') }), { name: 'gemini-2.5-pro', source: 'config' });
  assert.deepEqual(geminiModel({ env: {}, readFile: read('{"model":"flash"}') }), { name: 'flash', source: 'config' });
  assert.deepEqual(geminiModel({ env: { GEMINI_MODEL: 'env-model' }, readFile: read('{}') }), { name: 'env-model', source: 'config' });
  assert.deepEqual(geminiModel({ env: {}, readFile: read('깨진 파일') }), { name: '', source: 'default' });
  assert.deepEqual(claudeModel({ optionModel: 'sonnet', env: { ANTHROPIC_MODEL: 'claude-x' } }), { name: 'sonnet', source: 'option' });
  assert.deepEqual(claudeModel({ env: { ANTHROPIC_MODEL: 'claude-x' } }), { name: 'claude-x', source: 'config' });
  // AIPet은 ~/.claude/settings.json을 읽지 않게 하고 Claude를 실행하므로, 그 파일의 model은 근거로 쓰지 않는다
  assert.deepEqual(claudeModel({ env: {} }), { name: '', source: 'default' });
});

test('describeModel: 알아낸 방법을 함께 보여 주고, 모르면 모른다고 숨기지 않는다', () => {
  assert.equal(describeModel({ name: 'gpt-6-luna', source: 'config' }), 'gpt-6-luna (CLI 설정 파일 기준)');
  assert.match(describeModel({ name: 'gpt-6-luna', source: 'catalog' }), /추정/);
  assert.match(describeModel({ name: 'claude-sonnet-5-5', source: 'chat' }), /실제로 쓴/);
  assert.match(describeModel({ name: '', source: 'default' }), /확인할 수 없어요/);
  assert.equal(describeModel(null, { unknownHint: '힌트' }), '힌트');
});

test('대화 시작 때 CLI가 알려 주는 실제 모델을 읽는다 (Claude Code, Gemini)', () => {
  const st = { sawDelta: false, finished: false, status: null, sessionId: null };
  translateClaudeMessage({ type: 'system', subtype: 'init', model: 'claude-sonnet-5-5', session_id: 's1' }, st);
  assert.equal(/** @type {any} */ (st).model, 'claude-sonnet-5-5');
  const syn = { sawDelta: false, finished: false, status: null, sessionId: null };
  translateClaudeMessage({ type: 'system', subtype: 'init', model: '<synthetic>' }, syn);
  assert.equal(/** @type {any} */ (syn).model, undefined, '오류 안내용 가짜 모델 이름은 쓰지 않는다');
  translateClaudeMessage({ type: 'system', subtype: 'hook_started' }, syn);
  assert.equal(/** @type {any} */ (syn).model, undefined);

  const g = { finished: false, lastError: '', text: '', status: null };
  translateGeminiLine({ type: 'init', model: 'gemini-2.5-flash' }, g);
  assert.equal(/** @type {any} */ (g).model, 'gemini-2.5-flash');
});

test('고를 수 있는 모델 목록: 서버·API 응답에서 이름들을 뽑는다', () => {
  assert.deepEqual(parseOpenAIModels({ data: [{ id: 'llama3.2' }, { id: '' }, { x: 1 }, { id: 'qwen3' }] }), [
    { value: 'llama3.2', label: 'llama3.2' },
    { value: 'qwen3', label: 'qwen3' },
  ]);
  assert.deepEqual(parseOpenAIModels(null), []);
  assert.deepEqual(parseAnthropicModels({ data: [{ id: 'claude-opus-5-5', display_name: 'Claude Opus 5.5' }, { id: 'claude-haiku-5-5' }] }), [
    { value: 'claude-opus-5-5', label: 'Claude Opus 5.5' },
    { value: 'claude-haiku-5-5', label: 'claude-haiku-5-5' },
  ]);
  assert.ok(GEMINI_KNOWN_MODELS.length >= 3 && GEMINI_KNOWN_MODELS.every((m) => m.value && m.label));
  assert.deepEqual(CLAUDE_KNOWN_MODELS.slice(0, 3).map((m) => m.value), ['opus', 'sonnet', 'haiku'], 'Claude Code는 별명이 앞에 온다');
  assert.ok(CLAUDE_KNOWN_MODELS.every((m) => m.value && m.label));
});
