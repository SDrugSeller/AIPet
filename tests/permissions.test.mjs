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

test('웹 검색: 기본은 묻고, 설정을 켜면 자동 허용한다', () => {
  const search = { name: 'WebSearch', input: { query: '오늘 날씨' } };
  assert.equal(decide(search, policy).action, 'ask');
  assert.equal(decide(search, { ...policy, autoAllowWeb: false }).action, 'ask');
  assert.deepEqual(decide(search, { ...policy, autoAllowWeb: true }), { action: 'allow' });
});

test('웹 검색을 허용해도 페이지 가져오기(WebFetch)와 다른 위험한 도구는 계속 묻는다', () => {
  const on = { ...policy, autoAllowWeb: true };
  assert.equal(decide({ name: 'WebFetch', input: { url: 'https://example.com' } }, on).action, 'ask');
  assert.equal(decide({ name: 'Bash', input: { command: 'curl x' } }, on).action, 'ask');
  assert.equal(decide({ name: 'Write', input: { file_path: path.join(work, 'a.txt'), content: 'x' } }, on).action, 'ask');
});

// --- 승인 카드를 건너뛰는 설정 (파일 수정 / 명령 실행 / 페이지 가져오기) ---

const write = { name: 'Write', input: { file_path: path.join(work, 'a.txt'), content: 'x' } };
const edit = { name: 'Edit', input: { file_path: path.join(work, 'a.txt'), old_string: 'a', new_string: 'b' } };
const bash = { name: 'Bash', input: { command: 'dir' } };
const fetchTool = { name: 'WebFetch', input: { url: 'https://example.com' } };

test('파일 수정/명령 실행/페이지 가져오기는 기본이 모두 묻는다', () => {
  for (const req of [write, edit, bash, fetchTool]) assert.equal(decide(req, policy).action, 'ask', req.name);
});

test('파일 쓰기·수정 허용: Write/Edit/MultiEdit/NotebookEdit만 자동 허용하고 흔적 표시(auto)가 붙는다', () => {
  const on = { ...policy, autoAllowEdit: true };
  assert.deepEqual(decide(write, on), { action: 'allow', auto: true });
  assert.deepEqual(decide(edit, on), { action: 'allow', auto: true });
  assert.equal(decide({ name: 'MultiEdit', input: { file_path: path.join(work, 'a.txt'), edits: [] } }, on).action, 'allow');
  assert.equal(decide({ name: 'NotebookEdit', input: { notebook_path: path.join(work, 'n.ipynb') } }, on).action, 'allow');
  // 다른 종류는 이 설정으로 열리지 않는다
  assert.equal(decide(bash, on).action, 'ask');
  assert.equal(decide(fetchTool, on).action, 'ask');
});

test('명령 실행 허용: Bash/PowerShell만 자동 허용하고, 파일 수정이나 가져오기는 계속 묻는다', () => {
  const on = { ...policy, autoAllowShell: true };
  assert.deepEqual(decide(bash, on), { action: 'allow', auto: true });
  assert.equal(decide({ name: 'PowerShell', input: { command: 'dir' } }, on).action, 'allow');
  assert.equal(decide(write, on).action, 'ask');
  assert.equal(decide(fetchTool, on).action, 'ask');
});

test('페이지 가져오기 허용: WebFetch만 자동 허용한다 (웹 검색 설정과는 별개)', () => {
  assert.deepEqual(decide(fetchTool, { ...policy, autoAllowFetch: true }), { action: 'allow', auto: true });
  assert.equal(decide(fetchTool, { ...policy, autoAllowWeb: true }).action, 'ask');
  assert.equal(decide({ name: 'WebSearch', input: { query: 'x' } }, { ...policy, autoAllowFetch: true }).action, 'ask');
});

test('모든 자동 허용을 켜도 작업 폴더 밖의 경로는 거부하고, 목록에 없는 도구는 계속 묻는다', () => {
  const all = { ...policy, autoAllowEdit: true, autoAllowShell: true, autoAllowFetch: true, autoAllowWeb: true };
  const outside = { name: 'Write', input: { file_path: path.join(os.tmpdir(), 'elsewhere', 'x.txt'), content: 'x' } };
  assert.equal(decide(outside, all).action, 'deny');
  assert.equal(decide({ name: 'Edit', input: { file_path: path.join(work, '..', 'x.txt') } }, all).action, 'deny');
  assert.equal(decide({ name: 'mcp__server__do_thing', input: { a: 1 } }, all).action, 'ask');
  assert.equal(decide({ name: 'Task', input: {} }, all).action, 'ask');
});
