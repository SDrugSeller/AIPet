// @ts-check
import assert from 'node:assert/strict';
import test from 'node:test';
import { createToolSetup, findLoginUrl, isLoginUrl } from '../src/main/tools/toolSetup.js';

/** 끝나는 때를 테스트가 정하는 약속 */
function deferred() {
  /** @type {(v: any) => void} */
  let resolve = () => {};
  const promise = new Promise((r) => (resolve = r));
  return { promise, resolve };
}

const tick = () => new Promise((r) => setImmediate(r));

test('로그인 주소: 공식 로그인 페이지(https, openai.com/chatgpt.com)만 인정하고 색 코드와 따옴표는 걷어 낸다', () => {
  assert.equal(isLoginUrl('https://auth.openai.com/oauth/authorize?x=1'), true);
  assert.equal(isLoginUrl('https://chatgpt.com/auth'), true);
  assert.equal(isLoginUrl('http://auth.openai.com/x'), false, 'https만');
  assert.equal(isLoginUrl('https://openai.com.evil.example/x'), false, '비슷한 이름의 다른 주소');
  assert.equal(isLoginUrl('https://evil.example/?next=openai.com'), false);
  assert.equal(isLoginUrl('not a url'), false);
  assert.equal(findLoginUrl('Open this URL: https://auth.openai.com/oauth/authorize?a=1&b=2'), 'https://auth.openai.com/oauth/authorize?a=1&b=2');
  const esc = String.fromCharCode(27);
  assert.equal(findLoginUrl(`${esc}[36mhttps://auth.openai.com/x${esc}[0m`), 'https://auth.openai.com/x');
  assert.equal(findLoginUrl('Starting local login server on http://localhost:1455'), null);
  assert.equal(findLoginUrl('https://evil.example/x'), null);
});

test('설치: 진행 상태가 바뀌고, 끝나면 연결을 다시 확인한 뒤 완료를 알린다', async () => {
  const d = deferred();
  /** @type {string[]} */
  const log = [];
  /** @type {any[]} */
  const finished = [];
  const setup = createToolSetup({
    root: 'x',
    refresh: async () => void log.push('refresh'),
    findBin: () => null,
    installer: { installCodex: async ({ onProgress } = {}) => { onProgress?.({ step: 'node-download', message: '받는 중', percent: 40 }); return d.promise; } },
    onFinish: (r) => finished.push(r),
  });
  let changes = 0;
  setup.subscribe(() => changes++);

  assert.equal(setup.startInstall('gemini-cli'), false, 'Codex만 설치할 수 있다');
  assert.equal(setup.startInstall('codex-cli'), true);
  assert.equal(setup.startInstall('codex-cli'), false, '이미 하는 중이면 또 시작하지 않는다');
  assert.equal(setup.busy(), true);
  await tick();
  assert.equal(setup.state().install.phase, 'running');
  assert.equal(setup.state().install.percent, 40);
  assert.equal(setup.state().install.message, '받는 중');

  d.resolve({ ok: true, bin: 'C:\\codex.exe', version: 'codex-cli 0.171.0' });
  await tick();
  await tick();
  assert.deepEqual(log, ['refresh']);
  assert.equal(setup.state().install.phase, 'done');
  assert.match(setup.state().install.message, /0\.171\.0/);
  assert.equal(setup.busy(), false);
  assert.deepEqual(finished.map((r) => [r.kind, r.ok]), [['install', true]]);
  assert.ok(changes >= 3);
});

test('설치: 실패하면 이유를 남기고, 취소하면 중단 신호를 보내 cancelled로 알린다', async () => {
  /** @type {any[]} */
  const finished = [];
  const bad = createToolSetup({ root: 'x', refresh: async () => {}, findBin: () => null, installer: { installCodex: async () => ({ ok: false, step: 'network', reason: '인터넷 문제' }) }, onFinish: (r) => finished.push(r) });
  bad.startInstall('codex-cli');
  await tick();
  assert.equal(bad.state().install.phase, 'error');
  assert.equal(bad.state().install.reason, '인터넷 문제');
  assert.equal(finished[0].ok, false);

  const d = deferred();
  /** @type {AbortSignal | undefined} */
  let seen;
  const slow = createToolSetup({
    root: 'x',
    refresh: async () => {},
    findBin: () => null,
    installer: { installCodex: async ({ signal } = {}) => { seen = signal; signal?.addEventListener('abort', () => d.resolve({ ok: false, step: 'x', reason: '설치를 취소했어요', cancelled: true })); return d.promise; } },
    onFinish: (r) => finished.push(r),
  });
  slow.startInstall('codex-cli');
  await tick();
  slow.cancelInstall();
  await tick();
  assert.equal(seen?.aborted, true);
  assert.equal(finished.at(-1).cancelled, true);
  assert.equal(slow.state().install.phase, 'error');
});

test('로그인: codex를 못 찾으면 시작하지 않고, 찾으면 주소를 받아 두었다가 끝나면 그 연결만 다시 확인한다', async () => {
  const none = createToolSetup({ root: 'x', refresh: async () => {}, findBin: () => null, installer: { installCodex: async () => ({ ok: false, step: '', reason: '' }) } });
  const r0 = none.startLogin('c1');
  assert.equal(r0.ok, false);

  const d = deferred();
  /** @type {string[]} */
  const refreshed = [];
  /** @type {any[]} */
  const finished = [];
  const setup = createToolSetup({
    root: 'x',
    refresh: async (id) => void refreshed.push(String(id)),
    findBin: (id) => (id === 'c1' ? 'C:\\codex.exe' : null),
    installer: { installCodex: async () => ({ ok: false, step: '', reason: '' }) },
    login: async ({ onUrl }) => {
      onUrl?.('https://auth.openai.com/oauth/authorize?z=1');
      return d.promise;
    },
    onFinish: (r) => finished.push(r),
  });
  assert.equal(setup.startLogin('c1').ok, true);
  assert.equal(setup.startLogin('c1').ok, false, '하는 중에는 또 시작하지 않는다');
  assert.equal(setup.startInstall('codex-cli'), false, '로그인 중에는 설치를 시작하지 않는다');
  await tick();
  assert.equal(setup.state().login.phase, 'running');
  assert.equal(setup.state().login.url, 'https://auth.openai.com/oauth/authorize?z=1');
  d.resolve({ code: 0 });
  await tick();
  await tick();
  assert.deepEqual(refreshed, ['c1']);
  assert.equal(setup.state().login.phase, 'done');
  assert.deepEqual(finished.map((r) => [r.kind, r.ok, r.connId]), [['login', true, 'c1']]);
});

test('로그인: 끝나지 않으면 오류로, 취소하면 idle로 돌아간다', async () => {
  /** @type {any[]} */
  const finished = [];
  const failing = createToolSetup({ root: 'x', refresh: async () => {}, findBin: () => 'C:\\codex.exe', installer: { installCodex: async () => ({ ok: false, step: '', reason: '' }) }, login: async () => ({ code: 1 }), onFinish: (r) => finished.push(r) });
  failing.startLogin('c1');
  await tick();
  await tick();
  assert.equal(failing.state().login.phase, 'error');
  assert.match(failing.state().login.message, /다시 시도/);

  const d = deferred();
  const cancelable = createToolSetup({
    root: 'x',
    refresh: async () => {},
    findBin: () => 'C:\\codex.exe',
    installer: { installCodex: async () => ({ ok: false, step: '', reason: '' }) },
    login: async ({ signal }) => { signal?.addEventListener('abort', () => d.resolve({ code: null, aborted: true })); return d.promise; },
    onFinish: (r) => finished.push(r),
  });
  cancelable.startLogin('c1');
  await tick();
  cancelable.cancelLogin();
  await tick();
  assert.equal(cancelable.state().login.phase, 'idle');
  assert.equal(finished.at(-1).cancelled, true);
});

test('로그인 주소 열기: 공식 로그인 주소만 연다', () => {
  /** @type {string[]} */
  const opened = [];
  const setup = createToolSetup({ root: 'x', refresh: async () => {}, findBin: () => null, installer: { installCodex: async () => ({ ok: false, step: '', reason: '' }) }, openExternal: (u) => opened.push(u) });
  setup.openLoginUrl('https://evil.example/');
  setup.openLoginUrl('file:///C:/Windows/System32/calc.exe');
  setup.openLoginUrl('https://auth.openai.com/oauth/authorize');
  assert.deepEqual(opened, ['https://auth.openai.com/oauth/authorize']);
});

test('runLogin: 명령의 출력에서 공식 로그인 주소만 골라 알리고, 끝나면 종료 코드를 돌려준다 (Windows)', { skip: process.platform !== 'win32' }, async () => {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { runLogin } = await import('../src/main/tools/toolSetup.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aipet-login-'));
  try {
    const bin = path.join(dir, 'fakecodex.cmd');
    fs.writeFileSync(bin, '@echo off\r\necho Starting local login server on http://localhost:1455\r\necho If your browser did not open, navigate to this URL: https://auth.openai.com/oauth/authorize?x=1\r\necho https://evil.example/phish\r\nexit /b 0\r\n');
    /** @type {string[]} */
    const urls = [];
    const r = await runLogin({ bin, onUrl: (u) => urls.push(u) });
    assert.equal(r.code, 0);
    assert.deepEqual([...new Set(urls)], ['https://auth.openai.com/oauth/authorize?x=1']);
    const bad = path.join(dir, 'failcodex.cmd');
    fs.writeFileSync(bad, '@echo off\r\nexit /b 3\r\n');
    assert.equal((await runLogin({ bin: bad })).code, 3);
    const ac = new AbortController();
    const slow = path.join(dir, 'slowcodex.cmd');
    fs.writeFileSync(slow, '@echo off\r\nping -n 30 127.0.0.1 >nul\r\n');
    const pending = runLogin({ bin: slow, signal: ac.signal });
    setTimeout(() => ac.abort(), 300);
    assert.equal((await pending).aborted, true);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
