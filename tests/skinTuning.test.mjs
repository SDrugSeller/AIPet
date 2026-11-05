// @ts-check
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { applyTuning, checkSheets, detectFrameSize } from '../src/shared/skinTuning.js';
import { createStore } from '../src/main/store.js';

/** 현장냥이 스킨의 원본 값 */
const authored = { frameSize: { w: 160, h: 160 }, scale: 1, anchor: { x: 80, y: 156 }, hitbox: { x: 45, y: 24, w: 74, h: 132 } };

test('조정값이 없으면 원본 그대로다', () => {
  const r = applyTuning(authored);
  assert.deepEqual(r.frameSize, { w: 160, h: 160 });
  assert.equal(r.scale, 1);
  assert.deepEqual(r.anchor, { x: 80, y: 156 });
  assert.deepEqual(r.hitbox, { x: 45, y: 24, w: 74, h: 132 });
  assert.deepEqual(r.displaySize, { w: 160, h: 160 });
});

test('해상도를 2배로 바꿔도(프레임 320) 화면 크기는 그대로, 앵커/히트박스는 2배로 환산된다', () => {
  const r = applyTuning(authored, { frameW: 320, frameH: 320 });
  assert.deepEqual(r.frameSize, { w: 320, h: 320 });
  assert.equal(r.scale, 0.5); // 320px짜리를 160px로 보여 준다
  assert.deepEqual(r.displaySize, { w: 160, h: 160 });
  assert.deepEqual(r.anchor, { x: 160, y: 312 });
  assert.deepEqual(r.hitbox, { x: 90, y: 48, w: 148, h: 264 });
  // 화면에서의 발 위치/히트박스 크기는 원본과 같다 (좌표 × scale)
  assert.equal(r.anchor.y * r.scale, authored.anchor.y);
  assert.equal(r.hitbox.h * r.scale, authored.hitbox.h);
});

test('표시 높이를 지정하면 그 높이로 보이고, 앵커/히트박스가 함께 커지고 작아진다', () => {
  const r = applyTuning(authored, { displayH: 80 });
  assert.equal(r.scale, 0.5);
  assert.deepEqual(r.displaySize, { w: 80, h: 80 });
  // 프레임 크기는 그대로이므로 시트 기준 좌표는 변하지 않고, 화면에서는 절반이 된다
  assert.deepEqual(r.anchor, { x: 80, y: 156 });
  assert.equal(r.anchor.y * r.scale, 78);
  assert.equal(r.hitbox.h * r.scale, 66);
});

test('프레임 크기와 표시 높이를 함께 바꾼다', () => {
  const r = applyTuning(authored, { frameW: 256, frameH: 256, displayH: 192 });
  assert.equal(r.scale, 0.75);
  assert.deepEqual(r.displaySize, { w: 192, h: 192 });
  assert.deepEqual(r.anchor, { x: 128, y: 249.6 });
});

test('가로세로 비율이 다른 프레임도 방향별로 환산한다', () => {
  const r = applyTuning(authored, { frameW: 200, frameH: 100 });
  assert.deepEqual(r.anchor, { x: 100, y: 97.5 }); // x는 200/160, y는 100/160
  assert.deepEqual(r.hitbox, { x: 56.25, y: 15, w: 92.5, h: 82.5 });
});

test('히트박스가 없는 스킨은 프레임 전체를 히트박스로 본다', () => {
  const noHitbox = { frameSize: authored.frameSize, scale: authored.scale, anchor: authored.anchor };
  const r = applyTuning(noHitbox, { frameW: 320, frameH: 320 });
  assert.deepEqual(r.hitbox, { x: 0, y: 0, w: 320, h: 320 });
});

test('시트 점검: 너비는 프레임 너비 × 프레임 수, 높이는 프레임 높이여야 한다', () => {
  const sheets = [
    { anim: 'idle', frames: 6, width: 960, height: 160 },
    { anim: 'walk', frames: 8, width: 1000, height: 160 },
    { anim: 'sleep', frames: 4, width: 640, height: 128 },
  ];
  const problems = checkSheets({ w: 160, h: 160 }, sheets);
  assert.equal(problems.length, 2);
  assert.match(problems[0], /walk.*1000.*1280/);
  assert.match(problems[1], /sleep.*높이 128/);
  assert.deepEqual(checkSheets({ w: 160, h: 160 }, [sheets[0]]), []);
});

test('프레임 크기 자동 감지: 너비 ÷ 프레임 수, 나누어떨어지지 않으면 null', () => {
  assert.deepEqual(detectFrameSize({ frames: 6, width: 1536, height: 256 }), { w: 256, h: 256 });
  assert.equal(detectFrameSize({ frames: 6, width: 1000, height: 256 }), null);
  assert.equal(detectFrameSize({ frames: 0, width: 100, height: 100 }), null);
});

test('저장소: 범위 안의 정수만 저장하고, 재시작 후에도 유지된다', () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aipet-tune-')), 'settings.json');
  const safe = /** @type {any} */ ({ isEncryptionAvailable: () => true, encryptString: (/** @type {string} */ s) => Buffer.from(s), decryptString: (/** @type {Buffer} */ b) => b.toString() });
  const s = createStore({ file, safeStorage: safe });
  assert.deepEqual(s.get().skinTuning, {});

  const good = { 'genba-cat': { frameW: 320, frameH: 320, displayH: 160 } };
  s.update({ skinTuning: good });
  assert.deepEqual(s.get().skinTuning, good);
  assert.deepEqual(createStore({ file, safeStorage: safe }).get().skinTuning, good);

  for (const bad of [
    { 'genba-cat': { frameW: 4 } }, // 너무 작다
    { 'genba-cat': { frameW: 5000 } }, // 너무 크다
    { 'genba-cat': { frameW: 100.5 } }, // 정수가 아니다
    { 'genba-cat': { frameW: '320' } },
    { 'genba-cat': { displayH: 5 } },
    { 'genba-cat': { evil: 1 } }, // 모르는 항목
    { '../etc': { frameW: 100 } }, // 스킨 이름이 안전하지 않다
    'nope',
  ]) {
    s.update({ skinTuning: bad });
    assert.deepEqual(s.get().skinTuning, good, JSON.stringify(bad));
  }

  s.update({ skinTuning: {} }); // 원래대로
  assert.deepEqual(s.get().skinTuning, {});
});

test('실제 스킨들: 아무 조정도 하지 않으면 스킨의 시트 크기 검사를 통과하고, 환산 결과가 프레임 안에 있다', () => {
  const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, '$1')), '../skins');
  for (const id of fs.readdirSync(root, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name)) {
    const raw = JSON.parse(fs.readFileSync(path.join(root, id, 'skin.json'), 'utf8'));
    const r = applyTuning({ frameSize: raw.frameSize, scale: raw.scale ?? 1, anchor: raw.anchor, hitbox: raw.hitbox });
    assert.ok(r.anchor.x <= r.frameSize.w && r.anchor.y <= r.frameSize.h, id);
    assert.ok(r.hitbox.x + r.hitbox.w <= r.frameSize.w && r.hitbox.y + r.hitbox.h <= r.frameSize.h, id);
    // 2배/절반으로 바꿔도 여전히 프레임 안에 있다
    for (const k of [0.5, 2]) {
      const t = applyTuning({ frameSize: raw.frameSize, scale: raw.scale ?? 1, anchor: raw.anchor, hitbox: raw.hitbox }, { frameW: raw.frameSize.w * k, frameH: raw.frameSize.h * k });
      assert.ok(t.hitbox.x + t.hitbox.w <= t.frameSize.w + 1e-9 && t.hitbox.y + t.hitbox.h <= t.frameSize.h + 1e-9, `${id} ×${k}`);
    }
  }
});
