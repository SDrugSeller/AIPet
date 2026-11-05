// @ts-check
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { DEFAULTS, createStore } from '../src/main/store.js';

/** 암호화를 흉내 내는 가짜 safeStorage (실제로는 OS 키체인) */
const fakeSafe = (available = true) => ({
  isEncryptionAvailable: () => available,
  encryptString: (/** @type {string} */ s) => Buffer.from(`enc:${s}`),
  decryptString: (/** @type {Buffer} */ b) => b.toString().replace(/^enc:/, ''),
});

function tmpFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aipet-store-'));
  return { dir, file: path.join(dir, 'settings.json') };
}

test('파일이 없으면 기본값', () => {
  const { file } = tmpFile();
  const s = createStore({ file, safeStorage: fakeSafe() });
  assert.deepEqual(s.get(), DEFAULTS);
});

test('저장한 설정은 다시 열어도 유지된다 (재시작 후 설정 유지)', () => {
  const { file } = tmpFile();
  const a = createStore({ file, safeStorage: fakeSafe() });
  a.update({ permissions: { workDir: 'D:\\work' }, general: { sound: false }, backend: { selected: 'openai-compat' } });

  const b = createStore({ file, safeStorage: fakeSafe() });
  assert.equal(b.get().permissions.workDir, 'D:\\work');
  assert.equal(b.get().general.sound, false);
  assert.equal(b.get().backend.selected, 'openai-compat');
  assert.equal(b.get().permissions.autoAllowRead, true); // 건드리지 않은 값은 그대로
});

test('일부만 바꿔도 같은 그룹의 다른 값은 유지된다', () => {
  const { file } = tmpFile();
  const s = createStore({ file, safeStorage: fakeSafe() });
  s.update({ adapters: { 'claude-code': { tools: false } } });
  assert.equal(s.get().adapters['claude-code'].tools, false);
  assert.equal(s.get().adapters['claude-code'].enabled, true);
  assert.equal(s.get().adapters['openai-compat'].enabled, true);
});

test('잘못된 값과 모르는 키는 버린다', () => {
  const { file } = tmpFile();
  const s = createStore({ file, safeStorage: fakeSafe() });
  s.update({
    general: { sound: 'yes', evil: true },
    adapters: { 'openai-compat': { baseUrl: 'javascript:alert(1)', model: 5 } },
    unknownGroup: { a: 1 },
    permissions: { workDir: 'x'.repeat(5000) },
  });
  const g = s.get();
  assert.equal(g.general.sound, true);
  assert.equal(/** @type {any} */ (g.general).evil, undefined);
  assert.equal(g.adapters['openai-compat'].baseUrl, '');
  assert.equal(g.adapters['openai-compat'].model, '');
  assert.equal(/** @type {any} */ (g).unknownGroup, undefined);
  assert.equal(g.permissions.workDir, '');
});

test('http(s) 주소와 빈 값은 허용한다', () => {
  const { file } = tmpFile();
  const s = createStore({ file, safeStorage: fakeSafe() });
  s.update({ adapters: { 'openai-compat': { baseUrl: 'http://localhost:1234/v1' } } });
  assert.equal(s.get().adapters['openai-compat'].baseUrl, 'http://localhost:1234/v1');
  s.update({ adapters: { 'openai-compat': { baseUrl: '' } } });
  assert.equal(s.get().adapters['openai-compat'].baseUrl, '');
});

test('깨진 파일은 .broken으로 보존하고 기본값으로 시작한다', () => {
  const { file } = tmpFile();
  fs.writeFileSync(file, '{ not json');
  const s = createStore({ file, safeStorage: fakeSafe() });
  assert.deepEqual(s.get(), DEFAULTS);
  assert.ok(fs.existsSync(`${file}.broken`));
});

test('비밀은 암호화해서 저장하고 설정에는 노출하지 않는다', () => {
  const { file } = tmpFile();
  const s = createStore({ file, safeStorage: fakeSafe() });
  assert.deepEqual(s.setSecret('openaiKey', 'sk-secret-123'), { ok: true });
  assert.equal(s.getSecret('openaiKey'), 'sk-secret-123');
  assert.equal(s.hasSecret('openaiKey'), true);
  assert.equal(JSON.stringify(s.get()).includes('sk-secret'), false);
  assert.equal(fs.readFileSync(file, 'utf8').includes('sk-secret-123'), false); // 디스크에 평문 없음

  // 재시작 후에도 읽힌다
  assert.equal(createStore({ file, safeStorage: fakeSafe() }).getSecret('openaiKey'), 'sk-secret-123');

  s.setSecret('openaiKey', null);
  assert.equal(s.hasSecret('openaiKey'), false);
});

test('보안 저장소를 쓸 수 없으면 키를 저장하지 않는다 (평문 저장 금지)', () => {
  const { file } = tmpFile();
  const s = createStore({ file, safeStorage: fakeSafe(false) });
  const r = s.setSecret('openaiKey', 'sk-x');
  assert.equal(r.ok, false);
  assert.equal(s.hasSecret('openaiKey'), false);
  assert.equal(s.setSecret('unknown', 'x').ok, false);
});

test('변경하면 구독자에게 알린다', () => {
  const { file } = tmpFile();
  const s = createStore({ file, safeStorage: fakeSafe() });
  /** @type {any[]} */
  const seen = [];
  s.onChange((v) => seen.push(v.general.visible));
  s.update({ general: { visible: false } });
  assert.deepEqual(seen, [false]);
});

test('스킨 이름은 안전한 문자만 허용한다 (경로 조작 방지)', () => {
  const { file } = tmpFile();
  const s = createStore({ file, safeStorage: fakeSafe() });
  assert.equal(s.get().general.skin, 'default');
  s.update({ general: { skin: 'genba-cat' } });
  assert.equal(s.get().general.skin, 'genba-cat');
  for (const bad of ['../evil', 'a/b', 'a\b', '', 'x'.repeat(65), 5]) {
    s.update({ general: { skin: bad } });
    assert.equal(s.get().general.skin, 'genba-cat', String(bad));
  }
});
