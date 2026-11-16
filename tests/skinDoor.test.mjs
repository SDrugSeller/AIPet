// @ts-check
import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { validateSkin } from '../src/main/skinRoots.js';
import { doorFrameAt } from '../src/shared/motion.js';
import { resolveDoor, validateDoor } from '../src/shared/skinDoor.js';

const goodDoor = () => ({ sheet: 'door.png', frames: 10, openFrames: 6, frameSize: { w: 128, h: 128 }, anchor: { x: 64, y: 124 }, scale: 1 });

test('기본 스킨의 door 정의가 맞고, door.png의 크기가 프레임 크기 × 프레임 수와 같다', () => {
  const skin = JSON.parse(fs.readFileSync(new URL('../skins/default/skin.json', import.meta.url), 'utf8'));
  assert.equal(validateDoor(skin.door), null);
  assert.equal(validateSkin(skin), null);
  const png = fs.readFileSync(new URL(`../skins/default/${skin.door.sheet}`, import.meta.url));
  assert.equal(png.toString('ascii', 1, 4), 'PNG');
  assert.equal(png.readUInt32BE(16), skin.door.frameSize.w * skin.door.frames, '시트 너비');
  assert.equal(png.readUInt32BE(20), skin.door.frameSize.h, '시트 높이');
});

test('validateDoor: door가 없으면 통과(선택), 올바른 값도 통과', () => {
  assert.equal(validateDoor(undefined), null);
  assert.equal(validateDoor(goodDoor()), null);
  const noOpen = goodDoor();
  delete (/** @type {any} */ (noOpen).openFrames);
  assert.equal(validateDoor(noOpen), null, 'openFrames는 선택');
});

/** @type {[string, (d: any) => void][]} */
const BAD = [
  ['sheet 상위 경로', (d) => (d.sheet = '../x.png')],
  ['sheet 절대 경로', (d) => (d.sheet = '/etc/x.png')],
  ['sheet URL', (d) => (d.sheet = 'http://a/b.png')],
  ['sheet PNG 아님', (d) => (d.sheet = 'door.svg')],
  ['sheet 없음', (d) => delete d.sheet],
  ['frames 소수', (d) => (d.frames = 2.5)],
  ['frames 너무 큼', (d) => (d.frames = 1000)],
  ['openFrames가 frames보다 큼', (d) => (d.openFrames = 11)],
  ['openFrames 0', (d) => (d.openFrames = 0)],
  ['frameSize 범위 밖', (d) => (d.frameSize.w = 100000)],
  ['frameSize 없음', (d) => delete d.frameSize],
  ['anchor 숫자 아님', (d) => (d.anchor.x = '64')],
  ['scale 0', (d) => (d.scale = 0)],
];
for (const [label, mutate] of BAD) {
  test(`validateDoor: 거부 - ${label}`, () => {
    const d = goodDoor();
    mutate(d);
    assert.ok(validateDoor(d), `${label}가 통과했어요`);
  });
}

test('validateDoor: 객체가 아닌 값은 거부한다', () => {
  for (const v of [null, 5, 'door.png', [], true]) assert.ok(validateDoor(v), String(v));
});

test('validateSkin: 사용자 스킨의 door가 잘못되면 그 스킨을 거부한다', () => {
  const base = JSON.parse(fs.readFileSync(new URL('../skins/default/skin.json', import.meta.url), 'utf8'));
  base.door = { ...goodDoor(), sheet: '../door.png' };
  assert.match(String(validateSkin(base)), /door/);
});

test('resolveDoor: 펫 크기에 맞춘 배율과 화면 크기, 문 그림을 가진 스킨 폴더를 돌려준다', () => {
  const r = resolveDoor({ door: goodDoor(), owner: 'default', factor: 1.5, pixelArt: false });
  assert.equal(r.skin, 'default');
  assert.equal(r.sheet, 'door.png');
  assert.equal(r.scale, 1.5);
  assert.deepEqual(r.display, { w: 192, h: 192 });
  assert.equal(r.openFrames, 6);
  const whole = goodDoor();
  delete (/** @type {any} */ (whole).openFrames);
  assert.equal(resolveDoor({ door: whole, owner: 'mine', factor: 1, pixelArt: true }).openFrames, 10, 'openFrames를 생략하면 전부 열리는 그림');
  assert.equal(resolveDoor({ door: { ...goodDoor(), scale: 2 }, owner: 'mine', factor: 0.5, pixelArt: true }).scale, 1, '스킨의 scale에 펫 크기 배율이 곱해진다');
});

test('프레임이 한 장뿐인 문(토관 같은 그림)도 열려 있는 동안 계속 그 한 장이다', () => {
  const door = { x: 0, y: 0, w: 30, h: 60, t0: 1000, dur: 2000 };
  const one = { ...goodDoor(), frames: 1 };
  delete (/** @type {any} */ (one).openFrames);
  assert.equal(validateDoor(one), null);
  const spec = { frames: 1 };
  assert.equal(doorFrameAt(door, 900, spec), null);
  for (const t of [1010, 1200, 2000, 2800, 2999]) assert.equal(doorFrameAt(door, t, spec), 0, `t=${t}`);
  assert.equal(doorFrameAt(door, 3000, spec), null);
});
