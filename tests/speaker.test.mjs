// @ts-check
import assert from 'node:assert/strict';
import test from 'node:test';
import { pickSpeaker } from '../src/main/speaker.js';

const awakeAll = () => true;

test('펫이 없으면 말할 펫도 없다', () => {
  assert.equal(pickSpeaker({ ids: [], isAwake: awakeAll, lastId: null }), null);
});

test('처음에는 첫 번째 펫이 말하고, 그다음부터 돌아가며 말한다', () => {
  const ids = ['a', 'b', 'c'];
  const seq = [];
  let last = null;
  for (let i = 0; i < 5; i++) {
    last = pickSpeaker({ ids, isAwake: awakeAll, lastId: last });
    seq.push(last);
  }
  assert.deepEqual(seq, ['a', 'b', 'c', 'a', 'b']);
});

test('자는 펫은 건너뛰고 깨어 있는 펫끼리 돌아간다', () => {
  const ids = ['a', 'b', 'c'];
  const isAwake = (/** @type {string} */ id) => id !== 'b';
  assert.equal(pickSpeaker({ ids, isAwake, lastId: null }), 'a');
  assert.equal(pickSpeaker({ ids, isAwake, lastId: 'a' }), 'c', 'b는 자고 있어 c가 말한다');
  assert.equal(pickSpeaker({ ids, isAwake, lastId: 'c' }), 'a');
});

test('깨어 있는 펫이 하나뿐이면 계속 그 펫이 말한다', () => {
  const ids = ['a', 'b', 'c'];
  const isAwake = (/** @type {string} */ id) => id === 'b';
  assert.equal(pickSpeaker({ ids, isAwake, lastId: null }), 'b');
  assert.equal(pickSpeaker({ ids, isAwake, lastId: 'b' }), 'b');
});

test('모두 자고 있으면 자는 펫끼리라도 순서대로 돌아가며 말한다', () => {
  const ids = ['a', 'b'];
  const asleep = () => false;
  assert.equal(pickSpeaker({ ids, isAwake: asleep, lastId: null }), 'a');
  assert.equal(pickSpeaker({ ids, isAwake: asleep, lastId: 'a' }), 'b');
  assert.equal(pickSpeaker({ ids, isAwake: asleep, lastId: 'b' }), 'a');
});

test('직전에 말한 펫이 사라졌으면 처음부터 고른다', () => {
  assert.equal(pickSpeaker({ ids: ['a', 'b'], isAwake: awakeAll, lastId: '사라진펫' }), 'a');
});
