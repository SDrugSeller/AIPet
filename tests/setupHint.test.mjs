// @ts-check
import assert from 'node:assert/strict';
import test from 'node:test';
import { needsSetupHint, SETUP_HINT_TEXT } from '../src/main/setupHint.js';

const s = (/** @type {boolean} */ checked, /** @type {boolean} */ available) => ({ checked, available });

test('연결이 하나도 없으면(펫이 없으면) 안내하지 않는다', () => {
  assert.equal(needsSetupHint([]), false);
});

test('점검이 끝났고 쓸 수 있는 연결이 하나도 없으면 안내한다', () => {
  assert.equal(needsSetupHint([s(true, false)]), true);
  assert.equal(needsSetupHint([s(true, false), s(true, false)]), true);
});

test('하나라도 쓸 수 있으면 안내하지 않는다', () => {
  assert.equal(needsSetupHint([s(true, true)]), false);
  assert.equal(needsSetupHint([s(true, false), s(true, true)]), false);
});

test('점검이 끝나지 않은 연결이 있으면 아직 모르므로 안내하지 않는다', () => {
  assert.equal(needsSetupHint([s(false, false)]), false);
  assert.equal(needsSetupHint([s(true, false), s(false, false)]), false);
});

test('안내 문구는 한 줄이고 설정으로 이어지는 안내를 담는다', () => {
  assert.ok(!SETUP_HINT_TEXT.includes('\n'));
  assert.match(SETUP_HINT_TEXT, /설정/);
  assert.match(SETUP_HINT_TEXT, /CLI|API/);
});
