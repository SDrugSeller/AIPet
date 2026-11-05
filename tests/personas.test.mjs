// @ts-check
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { buildSystemPrompt, DEFAULT_PERSONA } from '../src/main/agent/adapter.js';
import { createPersonaStore, isValidPersonaId, MAX_PERSONA_CHARS } from '../src/main/personas.js';
import { createStore } from '../src/main/store.js';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '..');
const seedDir = path.join(root, 'personas');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aipet-persona-'));
}

test('처음에는 저장소의 기본 말투 파일들이 사용자 폴더로 복사된다', () => {
  const dir = path.join(tmpDir(), 'personas');
  const p = createPersonaStore({ dir, seedDir });
  const names = p.list().map((x) => x.name);
  assert.ok(names.includes('기본'));
  assert.ok(names.includes('현장냥이'));
  assert.ok(p.read('기본.txt')?.length);
});

test('사용자가 지운 말투는 다시 시작해도 되살아나지 않는다', () => {
  const dir = path.join(tmpDir(), 'personas');
  const a = createPersonaStore({ dir, seedDir });
  assert.ok(a.remove('현장냥이.txt').ok);
  const b = createPersonaStore({ dir, seedDir }); // 재시작
  assert.equal(b.list().some((x) => x.name === '현장냥이'), false);
});

test('내용을 고치면 파일에 저장되고, 없는 말투에는 쓰지 않는다', () => {
  const p = createPersonaStore({ dir: tmpDir(), seedDir });
  assert.ok(p.write('기본.txt', '새 내용').ok);
  assert.equal(p.read('기본.txt'), '새 내용');
  assert.equal(p.write('없는.txt', 'x').ok, false);
});

test('너무 긴 내용은 잘라서 저장한다', () => {
  const p = createPersonaStore({ dir: tmpDir(), seedDir });
  p.write('기본.txt', 'x'.repeat(MAX_PERSONA_CHARS + 500));
  assert.equal(p.read('기본.txt')?.length, MAX_PERSONA_CHARS);
});

test('새 말투: 이름의 위험한 문자는 지우고, 같은 이름은 번호를 붙인다', () => {
  const p = createPersonaStore({ dir: tmpDir(), seedDir });
  const a = p.create('츤데레', '츤츤');
  assert.deepEqual(a, { ok: true, id: '츤데레.txt' });
  assert.equal(p.read('츤데레.txt'), '츤츤');
  assert.equal(p.create('츤데레', '또').id, '츤데레 2.txt');
  assert.equal(p.create('a/b\\c:d', 'x').id, 'abcd.txt'); // 폴더 구분자 제거
  assert.equal(p.create('   ', 'x').ok, false);
  assert.equal(p.create('..', 'x').ok, false);
});

test('경로를 벗어나는 ID는 읽기/쓰기/삭제 모두 거부한다', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, '..', 'outside-secret.txt'), 'secret');
  const p = createPersonaStore({ dir, seedDir });
  for (const bad of ['../outside-secret.txt', '..\\outside-secret.txt', 'a/b.txt', 'C:\\x.txt', '.hidden.txt', 'noext']) {
    assert.equal(isValidPersonaId(bad), false, bad);
    assert.equal(p.read(bad), null, bad);
    assert.equal(p.write(bad, 'x').ok, false, bad);
    assert.equal(p.remove(bad).ok, false, bad);
  }
  assert.equal(fs.readFileSync(path.join(dir, '..', 'outside-secret.txt'), 'utf8'), 'secret');
});

test('말투 폴더의 .txt가 아닌 파일은 목록에 나오지 않는다', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'note.md'), 'x');
  fs.writeFileSync(path.join(dir, '진짜.txt'), 'x');
  const names = createPersonaStore({ dir }).list().map((x) => x.name);
  assert.deepEqual(names, ['진짜']);
});

test('설정에 저장하는 말투 이름도 안전한 파일 이름만 허용한다', () => {
  const file = path.join(tmpDir(), 'settings.json');
  const s = createStore({ file, safeStorage: /** @type {any} */ ({}) });
  assert.equal(s.get().persona.selected, '기본.txt');
  s.update({ persona: { selected: '현장냥이.txt' } });
  assert.equal(s.get().persona.selected, '현장냥이.txt');
  for (const bad of ['../x.txt', 'a/b.txt', 'noext', '', 5]) {
    s.update({ persona: { selected: bad } });
    assert.equal(s.get().persona.selected, '현장냥이.txt', String(bad));
  }
});

test('시스템 프롬프트 = 말투 + 도구 안내. 말투가 비어 있으면 기본 말투', () => {
  const off = buildSystemPrompt('말끝에 냥을 붙여', false);
  assert.ok(off.startsWith('말끝에 냥을 붙여'));
  assert.match(off, /cannot use tools/);
  assert.match(buildSystemPrompt('x', true), /user must approve/);
  assert.ok(buildSystemPrompt('', false).startsWith(DEFAULT_PERSONA));
  assert.ok(buildSystemPrompt(undefined, true).startsWith(DEFAULT_PERSONA));
});

test('BOM이 붙은 말투 파일(메모장으로 저장)은 BOM을 떼고 읽는다', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, '메모장.txt'), '\uFEFF말끝에 냥을 붙여', 'utf8');
  assert.equal(createPersonaStore({ dir }).read('메모장.txt'), '말끝에 냥을 붙여');
});
