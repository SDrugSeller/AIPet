// @ts-check
import assert from 'node:assert/strict';
import test from 'node:test';
import { moveDuration, positionAt } from '../src/shared/motion.js';

const base = { x: 100, y: 500, t0: 1000 };

test('walk: 등속으로 이동하고 목표에서 멈춘다', () => {
  const pet = { ...base, move: /** @type {const} */ ({ kind: 'walk', x1: 220, speed: 60 }) };
  assert.deepEqual(positionAt(pet, 1000), { x: 100, y: 500 });
  assert.deepEqual(positionAt(pet, 2000), { x: 160, y: 500 });
  assert.deepEqual(positionAt(pet, 99999), { x: 220, y: 500 }); // 지나치지 않는다
  assert.equal(moveDuration(pet), 2000);
});

test('walk: 왼쪽으로도 이동한다', () => {
  const pet = { ...base, move: /** @type {const} */ ({ kind: 'walk', x1: 40, speed: 30 }) };
  assert.deepEqual(positionAt(pet, 3000), { x: 40, y: 500 });
});

test('fall: 가속하며 떨어지고 바닥에서 멈춘다', () => {
  const pet = { ...base, move: /** @type {const} */ ({ kind: 'fall', y1: 800, g: 2000 }) };
  assert.equal(positionAt(pet, 1000).y, 500);
  assert.equal(positionAt(pet, 1100).y, 500 + 0.5 * 2000 * 0.01);
  assert.equal(positionAt(pet, 99999).y, 800);
  assert.ok(Math.abs(moveDuration(pet) - Math.sqrt((2 * 300) / 2000) * 1000) < 1e-9);
});

test('이동이 없으면 제자리, 시작 전 시각이면 시작 위치', () => {
  assert.deepEqual(positionAt({ ...base, move: null }, 5000), { x: 100, y: 500 });
  const pet = { ...base, move: /** @type {const} */ ({ kind: 'walk', x1: 300, speed: 50 }) };
  assert.deepEqual(positionAt(pet, 0), { x: 100, y: 500 });
});

test('jump: 포물선으로 목표에 도착하고, 중간에 위로 솟는다', () => {
  const pet = { x: 100, y: 800, t0: 0, move: /** @type {const} */ ({ kind: 'jump', x1: 300, y1: 400, dur: 1000, height: 60 }) };
  assert.deepEqual(positionAt(pet, 0), { x: 100, y: 800 });
  const mid = positionAt(pet, 500);
  assert.equal(mid.x, 200);
  assert.equal(mid.y, 600 - 60); // 직선 경로의 중간(600)보다 height만큼 높다
  assert.deepEqual(positionAt(pet, 1000), { x: 300, y: 400 });
  assert.deepEqual(positionAt(pet, 5000), { x: 300, y: 400 }); // 도착한 뒤에는 멈춘다
  assert.equal(moveDuration(pet), 1000);
});
