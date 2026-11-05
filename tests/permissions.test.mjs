// @ts-check
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { decide, describeRequest, isInside } from '../src/main/agent/permissions.js';

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'aipet-work-'));
const policy = { autoAllowRead: true, workDir: work };

test('작업 폴더 안의 읽기 전용 도구는 자동 허용', () => {
  assert.deepEqual(decide({ name: 'Read', input: { file_path: path.join(work, 'a.txt') } }, policy), { action: 'allow' });
  assert.deepEqual(decide({ name: 'Glob', input: { pattern: '*.js' } }, policy), { action: 'allow' });
  assert.deepEqual(decide({ name: 'Grep', input: { pattern: 'x', path: '.' } }, policy), { action: 'allow' });
});

test('자동 허용을 끄면 읽기도 묻는다', () => {
  const d = decide({ name: 'Read', input: { file_path: path.join(work, 'a.txt') } }, { ...policy, autoAllowRead: false });
  assert.equal(d.action, 'ask');
});

test('쓰기/명령/네트워크는 묻는다', () => {
  assert.equal(decide({ name: 'Write', input: { file_path: path.join(work, 'a.txt'), content: 'x' } }, policy).action, 'ask');
  assert.equal(decide({ name: 'Edit', input: { file_path: 'a.txt' } }, policy).action, 'ask');
  assert.equal(decide({ name: 'Bash', input: { command: 'dir' } }, policy).action, 'ask');
  assert.equal(decide({ name: 'WebFetch', input: { url: 'https://example.com' } }, policy).action, 'ask');
});

test('작업 폴더 밖의 경로는 읽기든 쓰기든 거부', () => {
  const outside = path.join(os.tmpdir(), 'somewhere-else', 'secret.txt');
  for (const name of ['Read', 'Write', 'Edit']) {
    const d = decide({ name, input: { file_path: outside } }, policy);
    assert.equal(d.action, 'deny', name);
    assert.match(d.reason ?? '', /작업 폴더/);
  }
});

test('".."로 작업 폴더를 벗어나는 경로도 거부', () => {
  const d = decide({ name: 'Write', input: { file_path: path.join(work, '..', 'escape.txt') } }, policy);
  assert.equal(d.action, 'deny');
  assert.equal(decide({ name: 'Read', input: { file_path: '../../etc/passwd' } }, policy).action, 'deny');
});

test('상대 경로는 작업 폴더 기준으로 판단한다', () => {
  assert.equal(decide({ name: 'Write', input: { file_path: 'sub/new.txt' } }, policy).action, 'ask');
});

test('isInside: 형제 폴더(접두사만 같은 경우)는 안이 아니다', () => {
  const sibling = `${work}-evil`;
  assert.equal(isInside(work, work), true);
  assert.equal(isInside(work, path.join(work, 'x', 'y')), true);
  assert.equal(isInside(work, sibling), false);
});

test('심볼릭 링크로 밖을 가리켜도 막는다', (t) => {
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aipet-out-'));
  const link = path.join(work, 'link');
  try {
    fs.symlinkSync(outsideDir, link, 'junction');
  } catch {
    t.skip('심볼릭 링크를 만들 수 없는 환경');
    return;
  }
  assert.equal(decide({ name: 'Write', input: { file_path: path.join(link, 'x.txt') } }, policy).action, 'deny');
});

test('describeRequest: 사용자가 무엇을 허용하는지 보여 준다', () => {
  assert.deepEqual(describeRequest('Bash', { command: 'rm -rf build' }), { title: '명령 실행 (Bash)', detail: 'rm -rf build' });
  const w = describeRequest('Write', { file_path: 'a.txt', content: 'hello' });
  assert.equal(w.title, '파일 쓰기');
  assert.match(w.detail, /a\.txt/);
  assert.match(w.detail, /hello/);
  assert.match(describeRequest('Unknown', { x: 1 }).title, /Unknown/);
  // 긴 내용은 잘린다
  assert.ok(describeRequest('Bash', { command: 'x'.repeat(5000) }).detail.length < 700);
});
