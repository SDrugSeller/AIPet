import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { createLogger } from '../src/main/logger.js';

const tmp = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aipet-log-')), 'logs', 'aipet.log');
const read = (f) => fs.readFileSync(f, 'utf8').trimEnd().split('\n');

test('한 줄에 시각·태그·내용을 쓰고 폴더가 없으면 만든다', () => {
  const file = tmp();
  const { log } = createLogger({ file, mirror: false });
  log('focus', 'sync want=', 2, { a: 1 });
  const [line] = read(file);
  assert.match(line, /^\d\d:\d\d:\d\d\.\d{3} \[focus\] sync want= 2 \{ a: 1 \}$/);
});

test('같은 줄이 연달아 오면 한 번만 쓴다', () => {
  const file = tmp();
  const { log } = createLogger({ file, mirror: false });
  log('window', 'A');
  log('window', 'A');
  log('window', 'B');
  log('window', 'A');
  assert.equal(read(file).length, 3);
});

test('1초에 너무 많이 쓰면 넘친 줄을 버리고 몇 줄인지 남긴다', () => {
  const file = tmp();
  let t = 1_000_000;
  const { log } = createLogger({ file, mirror: false, maxPerSec: 5, now: () => t });
  for (let i = 0; i < 20; i++) log('x', i);
  assert.equal(read(file).length, 5);
  t += 1500;
  log('x', 'next');
  const lines = read(file);
  assert.match(lines.at(-2), /\[log\] 15줄 생략/);
  assert.match(lines.at(-1), /\[x\] next/);
});

test('크기가 넘으면 .1.log로 넘기고 새로 시작한다 (2배 크기까지만 유지)', () => {
  const file = tmp();
  const { log } = createLogger({ file, mirror: false, maxBytes: 300, maxPerSec: 1000 });
  for (let i = 0; i < 60; i++) log('x', `줄 번호 ${i} ${'.'.repeat(20)}`);
  const rotated = file.replace(/\.log$/, '.1.log');
  assert.ok(fs.existsSync(rotated));
  assert.ok(fs.statSync(file).size <= 300);
  assert.ok(fs.statSync(rotated).size <= 300);
  assert.match(read(file).at(-1), /줄 번호 59/);
});

test('로그 폴더를 만들 수 없어도 예외를 던지지 않는다', () => {
  const blocker = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'aipet-log-')), 'file');
  fs.writeFileSync(blocker, 'x');
  const { log } = createLogger({ file: path.join(blocker, 'sub', 'aipet.log'), mirror: false });
  assert.doesNotThrow(() => log('x', 'hello'));
});
