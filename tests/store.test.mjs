// @ts-check
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { keySecretName, newConnection } from '../src/shared/connections.js';
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

const open = (/** @type {string} */ file, safe = fakeSafe()) => createStore({ file, safeStorage: safe });

test('파일이 없으면 기본값: Claude Code 연결 하나', () => {
  const { file } = tmpFile();
  const s = open(file);
  assert.deepEqual(s.get(), DEFAULTS);
  assert.equal(s.get().connections.length, 1);
  assert.equal(s.get().connections[0].kind, 'claude-code');
});

test('저장한 설정은 다시 열어도 유지된다 (재시작 후 설정 유지)', () => {
  const { file } = tmpFile();
  const a = open(file);
  const conns = [...a.get().connections, newConnection('openai-compat', a.get().connections)];
  a.update({ connections: conns, permissions: { workDir: 'D:\\work' }, general: { sound: false } });

  const b = open(file);
  assert.equal(b.get().connections.length, 2);
  assert.equal(b.get().connections[1].kind, 'openai-compat');
  assert.equal(b.get().permissions.workDir, 'D:\\work');
  assert.equal(b.get().general.sound, false);
  assert.equal(b.get().permissions.autoAllowRead, true); // 건드리지 않은 값은 그대로
  assert.equal(b.get().permissions.autoAllowWeb, false); // 웹 검색 허용은 기본 꺼짐
});

test('일부만 바꿔도 같은 그룹의 다른 값은 유지된다', () => {
  const { file } = tmpFile();
  const s = open(file);
  s.update({ permissions: { workDir: 'X' } });
  assert.equal(s.get().permissions.workDir, 'X');
  assert.equal(s.get().permissions.autoAllowRead, true);
});

test('잘못된 값과 모르는 키는 버린다', () => {
  const { file } = tmpFile();
  const s = open(file);
  s.update({
    general: { sound: 'yes', evil: true },
    unknownGroup: { a: 1 },
    permissions: { workDir: 'x'.repeat(5000) },
  });
  const g = s.get();
  assert.equal(g.general.sound, true);
  assert.equal(/** @type {any} */ (g.general).evil, undefined);
  assert.equal(/** @type {any} */ (g).unknownGroup, undefined);
  assert.equal(g.permissions.workDir, '');
});

test('연결 목록 검증: 형식이 틀린 목록은 통째로 거부하고 이전 값을 유지한다', () => {
  const { file } = tmpFile();
  const s = open(file);
  const base = s.get().connections[0];
  const bad = [
    [{ ...base, kind: 'nope' }], // 모르는 종류
    [{ ...base, id: 'Bad Id' }], // 안전하지 않은 id
    [{ ...base, name: '' }], // 이름 없음
    [{ ...base, skin: '../evil' }], // 경로 조작
    [{ ...base, persona: 'a/b.txt' }],
    [{ ...base, options: { ...base.options, evil: 1 } }], // 모르는 옵션
    [{ ...base, options: { ...base.options, tools: 'yes' } }], // 옵션 형식
    [base, { ...base }], // id 중복
    Array.from({ length: 9 }, (_, i) => ({ ...base, id: `c${i}` })), // 너무 많다
    'not an array',
  ];
  for (const b of bad) {
    s.update({ connections: b });
    assert.deepEqual(s.get().connections, [base], JSON.stringify(b).slice(0, 80));
  }
});

test('연결 옵션의 주소는 http(s)와 빈 값만 허용한다', () => {
  const { file } = tmpFile();
  const s = open(file);
  const c = newConnection('openai-compat', []);
  s.update({ connections: [{ ...c, options: { ...c.options, baseUrl: 'http://localhost:1234/v1' } }] });
  assert.equal(s.get().connections[0].options.baseUrl, 'http://localhost:1234/v1');
  s.update({ connections: [{ ...c, options: { ...c.options, baseUrl: 'javascript:alert(1)' } }] });
  assert.equal(s.get().connections[0].options.baseUrl, 'http://localhost:1234/v1'); // 거부되어 이전 값 유지
  s.update({ connections: [{ ...c, options: { ...c.options, baseUrl: '' } }] });
  assert.equal(s.get().connections[0].options.baseUrl, '');
});

test('연결을 모두 지워도 되고(펫 없음), 종류마다 기본 옵션이 다르다', () => {
  const { file } = tmpFile();
  const s = open(file);
  s.update({ connections: [] });
  assert.deepEqual(s.get().connections, []);
  assert.equal(newConnection('anthropic-api', []).options.model, 'claude-opus-5-5');
  assert.equal(newConnection('claude-code', []).options.tools, true);
});

test('깨진 파일은 .broken으로 보존하고 기본값으로 시작한다', () => {
  const { file } = tmpFile();
  fs.writeFileSync(file, '{ not json');
  const s = open(file);
  assert.deepEqual(s.get(), DEFAULTS);
  assert.ok(fs.existsSync(`${file}.broken`));
});

test('BOM이 붙은 설정 파일(메모장으로 저장)도 읽는다', () => {
  const { file } = tmpFile();
  fs.writeFileSync(file, '\uFEFF' + JSON.stringify({ general: { sound: false } }), 'utf8');
  const s = open(file);
  assert.equal(s.get().general.sound, false);
  assert.equal(fs.existsSync(`${file}.broken`), false); // 깨진 파일로 취급하지 않는다
});

test('API 키는 연결마다 따로 암호화해서 저장하고 설정에는 노출하지 않는다', () => {
  const { file } = tmpFile();
  const s = open(file);
  const id = s.get().connections[0].id;
  const name = keySecretName(id);
  assert.deepEqual(s.setSecret(name, 'sk-secret-123'), { ok: true });
  assert.equal(s.getSecret(name), 'sk-secret-123');
  assert.equal(s.hasSecret(name), true);
  assert.equal(JSON.stringify(s.get()).includes('sk-secret'), false);
  assert.equal(fs.readFileSync(file, 'utf8').includes('sk-secret-123'), false); // 디스크에 평문 없음

  // 재시작 후에도 읽힌다
  assert.equal(open(file).getSecret(name), 'sk-secret-123');

  s.setSecret(name, null);
  assert.equal(s.hasSecret(name), false);
});

test('연결을 지우면 그 연결의 API 키도 함께 지워진다', () => {
  const { file } = tmpFile();
  const s = open(file);
  const a = s.get().connections[0];
  const b = newConnection('anthropic-api', [a]);
  s.update({ connections: [a, b] });
  s.setSecret(keySecretName(b.id), 'sk-b');
  s.setSecret(keySecretName(a.id), 'sk-a');
  s.update({ connections: [a] });
  assert.equal(s.hasSecret(keySecretName(b.id)), false);
  assert.equal(s.getSecret(keySecretName(a.id)), 'sk-a');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).secrets[keySecretName(b.id)], undefined);
});

test('없는 연결이나 잘못된 이름의 비밀은 저장하지 않는다', () => {
  const { file } = tmpFile();
  const s = open(file);
  assert.equal(s.setSecret('key:ghost', 'x').ok, false);
  assert.equal(s.setSecret('openaiKey', 'x').ok, false); // 예전 이름
  assert.equal(s.setSecret('../x', 'x').ok, false);
});

test('보안 저장소를 쓸 수 없으면 키를 저장하지 않는다 (평문 저장 금지)', () => {
  const { file } = tmpFile();
  const s = open(file, fakeSafe(false));
  const name = keySecretName(s.get().connections[0].id);
  assert.equal(s.setSecret(name, 'sk-x').ok, false);
  assert.equal(s.hasSecret(name), false);
});

test('변경하면 구독자에게 알린다', () => {
  const { file } = tmpFile();
  const s = open(file);
  /** @type {any[]} */
  const seen = [];
  s.onChange((v) => seen.push(v.general.visible));
  s.update({ general: { visible: false } });
  assert.deepEqual(seen, [false]);
});

test('행동/알림 설정: 범위와 형식을 검증한다', () => {
  const { file } = tmpFile();
  const s = open(file);
  assert.equal(s.get().behavior.sitOnWindows, true);
  assert.equal(s.get().spontaneous.breakReminder, false); // 먼저 말 거는 기능은 옵트인
  assert.equal(s.get().general.doNotDisturb, false);

  s.update({ spontaneous: { breakAfterMin: 90, cooldownMin: 15 }, general: { doNotDisturb: true } });
  assert.equal(s.get().spontaneous.breakAfterMin, 90);
  assert.equal(s.get().general.doNotDisturb, true);

  for (const bad of [0, 4, 601, 1.5, '60', NaN]) {
    s.update({ spontaneous: { breakAfterMin: bad } });
    assert.equal(s.get().spontaneous.breakAfterMin, 90, String(bad));
  }
});

test('정해진 시각 알림 목록: 형식이 맞아야 저장되고 재시작 후에도 유지된다', () => {
  const { file } = tmpFile();
  const s = open(file);
  const good = [{ time: '12:30', text: '점심!', enabled: true }];
  s.update({ spontaneous: { reminders: good } });
  assert.deepEqual(s.get().spontaneous.reminders, good);
  assert.deepEqual(open(file).get().spontaneous.reminders, good);

  for (const bad of [
    [{ time: '25:00', text: 'x', enabled: true }],
    [{ time: '9:00', text: 'x', enabled: true }],
    [{ time: '12:30', text: 'x'.repeat(201), enabled: true }],
    [{ time: '12:30', text: 'x' }],
    'not an array',
    Array.from({ length: 21 }, () => ({ time: '12:00', text: 'x', enabled: true })),
  ]) {
    s.update({ spontaneous: { reminders: bad } });
    assert.deepEqual(s.get().spontaneous.reminders, good);
  }
});

test('먼저 말 걸기 전체 스위치는 기본 켜짐이고, 저장되며 재시작 후에도 유지된다', () => {
  const { file } = tmpFile();
  const s = open(file);
  assert.equal(s.get().spontaneous.enabled, true);
  s.update({ spontaneous: { enabled: false } });
  assert.equal(open(file).get().spontaneous.enabled, false);
  s.update({ spontaneous: { enabled: 'no' } });
  assert.equal(s.get().spontaneous.enabled, false);
});

// --- 예전 설정(v1: 연결이 하나뿐이던 시절)을 새 형식으로 옮기기 ---

test('예전 설정 이전: Claude Code 연결 하나로 옮기고 스킨/말투/경로/도구 설정을 이어받는다', () => {
  const { file } = tmpFile();
  fs.writeFileSync(
    file,
    JSON.stringify({
      adapters: { 'claude-code': { enabled: true, path: 'C:\\bin\\claude.exe', tools: false }, 'openai-compat': { enabled: true, baseUrl: '', model: '' } },
      general: { skin: 'genba-cat', sound: false },
      persona: { selected: '현장냥이.txt' },
      backend: { selected: 'claude-code' },
    }),
  );
  const s = open(file);
  const conns = s.get().connections;
  assert.equal(conns.length, 1); // 설정하지 않은 OpenAI 호환 연결은 만들지 않는다 (안 쓰던 캐릭터가 생기지 않게)
  assert.deepEqual(
    { id: conns[0].id, kind: conns[0].kind, skin: conns[0].skin, persona: conns[0].persona, enabled: conns[0].enabled },
    { id: 'claude-code', kind: 'claude-code', skin: 'genba-cat', persona: '현장냥이.txt', enabled: true },
  );
  assert.equal(conns[0].options.path, 'C:\\bin\\claude.exe');
  assert.equal(conns[0].options.tools, false);
  assert.equal(s.get().general.sound, false); // 다른 설정은 그대로
});

test('예전 설정 이전: 설정해 둔 OpenAI 호환 연결과 그 API 키는 새 연결로 옮긴다', () => {
  const { file } = tmpFile();
  const safe = fakeSafe();
  const oldKey = safe.encryptString('sk-old').toString('base64');
  fs.writeFileSync(
    file,
    JSON.stringify({
      adapters: { 'claude-code': { enabled: false }, 'openai-compat': { enabled: true, baseUrl: 'http://127.0.0.1:11434/v1', model: 'llama3.2' } },
      secrets: { openaiKey: oldKey },
    }),
  );
  const s = open(file, safe);
  const conns = s.get().connections;
  assert.deepEqual(conns.map((c) => [c.id, c.kind, c.enabled]), [['claude-code', 'claude-code', false], ['openai-compat', 'openai-compat', true]]);
  assert.equal(conns[1].options.model, 'llama3.2');
  assert.equal(s.getSecret(keySecretName('openai-compat')), 'sk-old');

  // 새 형식으로 바로 저장되어, 다시 열어도 같고 예전 항목은 남지 않는다
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.adapters, undefined);
  assert.equal(saved.secrets.openaiKey, undefined);
  assert.equal(open(file, safe).get().connections.length, 2);
});

test('이미 새 형식이면 이전하지 않는다', () => {
  const { file } = tmpFile();
  const s = open(file);
  s.update({ connections: [] });
  const again = open(file);
  assert.deepEqual(again.get().connections, []); // 기본 연결로 되살아나지 않는다
});
