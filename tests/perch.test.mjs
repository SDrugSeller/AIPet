// @ts-check
import assert from 'node:assert/strict';
import test from 'node:test';
import { bodyMetrics, computePerch } from '../src/main/perch.js';

/** 현장냥이 스킨과 같은 크기 */
const skin = { anchor: { x: 80, y: 156 }, scale: 1, hitbox: { x: 45, y: 24, w: 74, h: 132 }, frameSize: { w: 160, h: 160 } };
const m = bodyMetrics(skin);

/** 1920×1080 모니터, 작업표시줄 48px */
const display = { id: 1, bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1032 } };
const rect = (x, y, width, height) => ({ x, y, width, height });
const win = (r, flags = {}) => ({ id: 'w1', rect: r, ...flags });

test('몸 크기는 투명 여백이 아니라 히트박스 기준이다', () => {
  assert.deepEqual(m, { bodyLeft: 35, bodyRight: 39, bodyUp: 132 });
});

test('모니터 한가운데의 보통 창은 올라갈 수 있다', () => {
  const p = computePerch(win(rect(400, 300, 800, 500)), [display], m);
  assert.deepEqual(p, { id: 'w1', left: 400, right: 1200, top: 300, display: 1 });
});

test('최대화/최소화/전체화면 창은 올라갈 수 없다', () => {
  for (const flag of ['maximized', 'minimized', 'fullscreen']) {
    assert.equal(computePerch(win(rect(0, 0, 1920, 1032), { [flag]: true }), [display], m), null, flag);
  }
});

test('머리가 화면 위로 나갈 만큼 위쪽에 있는 창은 제외한다', () => {
  // 창 윗변 y=100 → 키 132짜리 몸이 들어가지 않는다
  assert.equal(computePerch(win(rect(400, 100, 800, 500)), [display], m), null);
  assert.ok(computePerch(win(rect(400, 140, 800, 500)), [display], m));
});

test('바닥과 거의 같은 높이의 창은 올라갈 이유가 없다', () => {
  assert.equal(computePerch(win(rect(400, 990, 800, 90)), [display], m), null);
});

test('몸이 들어가지 않는 좁은 창과 너무 낮은 창은 제외한다', () => {
  assert.equal(computePerch(win(rect(400, 300, 60, 500)), [display], m), null);
  assert.equal(computePerch(win(rect(400, 300, 800, 40)), [display], m), null);
});

test('모니터 밖으로 걸친 창은 모니터 안쪽 구간만 쓴다', () => {
  const p = computePerch(win(rect(-300, 300, 800, 500)), [{ ...display }], m);
  // 윗변 가운데(x=100)는 모니터 안: 왼쪽은 모니터 가장자리에서 잘린다
  assert.deepEqual(p && [p.left, p.right], [0, 500]);
});

test('윗변 가운데가 어느 모니터에도 없으면 null', () => {
  assert.equal(computePerch(win(rect(5000, 300, 800, 500)), [display], m), null);
});

test('두 번째 모니터의 창은 그 모니터 기준으로 판단한다', () => {
  const d2 = { id: 2, bounds: { x: 1920, y: -200, width: 1080, height: 1920 }, workArea: { x: 1920, y: -200, width: 1080, height: 1872 } };
  const p = computePerch(win(rect(2000, 400, 700, 600)), [display, d2], m);
  assert.deepEqual(p && [p.display, p.top, p.left, p.right], [2, 400, 2000, 2700]);
});
