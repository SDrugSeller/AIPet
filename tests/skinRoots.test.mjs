// @ts-check
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createSkinRoots, validateSkin } from '../src/main/skinRoots.js';

const goodSkin = () => ({
  schemaVersion: 1,
  name: 'ok',
  frameSize: { w: 64, h: 64 },
  anchor: { x: 32, y: 60 },
  animations: { idle: { sheet: 'idle.png', frames: 4, fps: 6 } },
});

/** @param {string} root @param {string} id @param {any} [json] */
function addSkin(root, id, json = goodSkin()) {
  fs.mkdirSync(path.join(root, id), { recursive: true });
  fs.writeFileSync(path.join(root, id, 'skin.json'), typeof json === 'string' ? json : JSON.stringify(json));
}

function setup() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aipet-skins-'));
  const bundled = path.join(base, 'bundled');
  const user = path.join(base, 'user');
  fs.mkdirSync(bundled);
  fs.mkdirSync(user);
  return { base, bundled, user, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

test('번들 스킨과 사용자 스킨을 모두 찾고, 출처를 구분한다', () => {
  const t = setup();
  try {
    addSkin(t.bundled, 'default');
    addSkin(t.user, 'my-skin');
    const roots = createSkinRoots({ bundled: t.bundled, user: t.user });
    assert.equal(roots.resolve('default')?.source, 'bundled');
    assert.equal(roots.resolve('my-skin')?.source, 'user');
    assert.deepEqual(roots.list().map((s) => [s.id, s.source]), [['default', 'bundled'], ['my-skin', 'user']]);
  } finally {
    t.cleanup();
  }
});

test('같은 이름이면 번들 스킨이 우선한다 (사용자가 default를 덮어쓸 수 없다)', () => {
  const t = setup();
  try {
    addSkin(t.bundled, 'default');
    addSkin(t.user, 'default');
    const roots = createSkinRoots({ bundled: t.bundled, user: t.user });
    assert.equal(roots.resolve('default')?.source, 'bundled');
    assert.equal(roots.list().filter((s) => s.id === 'default').length, 1);
  } finally {
    t.cleanup();
  }
});

test('사용자 폴더가 아직 없어도 오류 없이 번들 스킨만 보인다', () => {
  const t = setup();
  try {
    addSkin(t.bundled, 'default');
    const roots = createSkinRoots({ bundled: t.bundled, user: path.join(t.base, 'missing') });
    assert.deepEqual(roots.list().map((s) => s.id), ['default']);
    assert.equal(roots.resolve('nope'), null);
  } finally {
    t.cleanup();
  }
});

test('사용자 스킨의 폴더 이름은 영숫자/-/_ 만 허용하고, 그 밖은 목록과 해석에서 제외한다', () => {
  const t = setup();
  try {
    for (const bad of ['한글스킨', 'has space', '.hidden', 'a.b']) addSkin(t.user, bad);
    addSkin(t.user, 'good_1');
    const roots = createSkinRoots({ bundled: t.bundled, user: t.user });
    assert.deepEqual(roots.list().map((s) => s.id), ['good_1']);
    for (const bad of ['한글스킨', 'has space', '.hidden', 'a.b']) assert.equal(roots.resolve(bad), null, bad);
  } finally {
    t.cleanup();
  }
});

test('경로 이탈(.., 절대경로, 구분자)로는 스킨 폴더 밖을 읽을 수 없다', () => {
  const t = setup();
  try {
    addSkin(t.base, 'outside'); // base/outside/skin.json
    addSkin(t.user, 'inside');
    const roots = createSkinRoots({ bundled: t.bundled, user: t.user });
    assert.equal(roots.resolve('../outside'), null);
    assert.equal(roots.resolve('..'), null);
    assert.equal(roots.resolve(path.join(t.base, 'outside')), null);
    assert.equal(roots.resolve('inside/../../outside'), null);
    assert.equal(roots.resolve(''), null);
    // @ts-expect-error 문자열이 아닌 값
    assert.equal(roots.resolve(null), null);
  } finally {
    t.cleanup();
  }
});

test('대소문자만 다른 이름도 찾는다 (aipet-skin:// 호스트는 소문자로 바뀐다)', () => {
  const t = setup();
  try {
    addSkin(t.user, 'MySkin');
    const roots = createSkinRoots({ bundled: t.bundled, user: t.user });
    assert.equal(roots.resolve('myskin')?.source, 'user');
  } finally {
    t.cleanup();
  }
});

test('skin.json이 없는 폴더는 스킨이 아니다', () => {
  const t = setup();
  try {
    fs.mkdirSync(path.join(t.user, 'empty'));
    const roots = createSkinRoots({ bundled: t.bundled, user: t.user });
    assert.equal(roots.resolve('empty'), null);
    assert.deepEqual(roots.list(), []);
  } finally {
    t.cleanup();
  }
});

test('너무 큰 skin.json은 한도 검사에서 걸린다', () => {
  const t = setup();
  try {
    addSkin(t.user, 'big', ' '.repeat(300 * 1024));
    addSkin(t.user, 'small');
    const roots = createSkinRoots({ bundled: t.bundled, user: t.user });
    assert.equal(roots.skinJsonSizeOk(path.join(t.user, 'big')), false);
    assert.equal(roots.skinJsonSizeOk(path.join(t.user, 'small')), true);
  } finally {
    t.cleanup();
  }
});

// --- validateSkin ---

test('validateSkin: 올바른 skin.json은 통과하고, 번들 default 스킨도 통과한다', () => {
  assert.equal(validateSkin(goodSkin()), null);
  const def = JSON.parse(fs.readFileSync(new URL('../skins/default/skin.json', import.meta.url), 'utf8'));
  assert.equal(validateSkin(def), null);
});

/** @type {[string, (s: any) => void][]} */
const BAD = [
  ['idle 없음', (s) => delete s.animations.idle],
  ['frameSize 범위 밖', (s) => (s.frameSize.w = 100000)],
  ['frameSize 숫자 아님', (s) => (s.frameSize.h = '64')],
  ['anchor 없음', (s) => delete s.anchor],
  ['scale 0', (s) => (s.scale = 0)],
  ['hitbox 일부 누락', (s) => (s.hitbox = { x: 0, y: 0 })],
  ['sheet 상위 경로', (s) => (s.animations.idle.sheet = '../x.png')],
  ['sheet 절대 경로', (s) => (s.animations.idle.sheet = '/etc/x.png')],
  ['sheet URL', (s) => (s.animations.idle.sheet = 'http://a/b.png')],
  ['sheet PNG 아님', (s) => (s.animations.idle.sheet = 'a.svg')],
  ['frames 소수', (s) => (s.animations.idle.frames = 2.5)],
  ['frames 너무 큼', (s) => (s.animations.idle.frames = 1000)],
  ['fps 0', (s) => (s.animations.idle.fps = 0)],
  ['fps NaN 문자열', (s) => (s.animations.idle.fps = 'fast')],
  ['상태 이름 형식', (s) => (s.animations['Bad Name'] = { sheet: 'a.png', frames: 1, fps: 1 })],
  ['next 숫자', (s) => (s.animations.idle.next = 3)],
];
for (const [label, mutate] of BAD) {
  test(`validateSkin: 거부 - ${label}`, () => {
    const s = goodSkin();
    mutate(s);
    assert.ok(validateSkin(s), `${label}가 통과했어요`);
  });
}

test('validateSkin: 객체가 아닌 입력은 거부한다', () => {
  for (const v of [null, undefined, 3, 'x', [], true]) assert.ok(validateSkin(v));
});
