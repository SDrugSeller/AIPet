// @ts-check
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { run, spawnCli } from '../src/main/agent/cli.js';
import { createCodexCliAdapter } from '../src/main/agent/codexCliAdapter.js';
import { createToolSetup } from '../src/main/tools/toolSetup.js';

/**
 * Windows가 실행을 거부하는 파일을 만든다: whoami.exe 복사본에서 현재 사용자의 읽기·실행을 막는다.
 * (사용자 PC에서 Store 앱 안의 codex.exe가 막힌 것과 같은 상황. 만들 수 없는 환경이면 null)
 */
function makeBlockedExe() {
  if (process.platform !== 'win32') return null;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aipet-blocked-'));
  const exe = path.join(dir, 'blocked.exe');
  try {
    fs.copyFileSync(path.join(process.env.SystemRoot ?? String.raw`C:\Windows`, 'System32', 'whoami.exe'), exe);
    const user = process.env.USERNAME ?? '';
    execFileSync('icacls', [exe, '/inheritance:r'], { stdio: 'ignore' });
    execFileSync('icacls', [exe, '/deny', `${user}:(RX)`], { stdio: 'ignore' });
    return { dir, exe, cleanup: () => {
      try { execFileSync('icacls', [exe, '/reset'], { stdio: 'ignore' }); } catch { /* 이미 지워졌을 수 있다 */ }
      fs.rmSync(dir, { recursive: true, force: true });
    } };
  } catch {
    fs.rmSync(dir, { recursive: true, force: true });
    return null;
  }
}

test('실행이 거부돼도 spawnCli는 예외를 던지지 않고 error 이벤트를 낸다 (Node의 spawn은 즉시 예외를 던진다)', async (t) => {
  const b = makeBlockedExe();
  if (!b) return t.skip('실행을 막는 파일을 만들 수 없는 환경');
  try {
    const child = spawnCli(b.exe, [], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const err = await new Promise((resolve) => child.on('error', resolve));
    assert.match(String(/** @type {Error} */ (err).message), /spawn/);
    assert.equal(child.stdout, null);
    const r = await run(b.exe, ['--version'], 5000);
    assert.equal(r.code, null, 'run도 실패 결과로 돌려준다 (거부되지 않고 멈추지도 않는다)');
    assert.match(r.stderr, /spawn/);
  } finally {
    b.cleanup();
  }
});

test('Codex 점검: 지정한 경로의 파일이 막혔으면 launch-failed, 없으면 bad-path로 알려 설치하기 버튼을 띄울 수 있다', async (t) => {
  const b = makeBlockedExe();
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'aipet-work-'));
  try {
    const missing = await createCodexCliAdapter({ getConfig: () => ({ path: path.join(work, 'nope', 'codex.exe'), workDir: work }) }).detect();
    assert.equal(missing.ok, false);
    assert.equal(missing.problem, 'bad-path');
    if (!b) return t.skip('실행을 막는 파일을 만들 수 없는 환경');
    const blocked = await createCodexCliAdapter({ getConfig: () => ({ path: b.exe, workDir: work }) }).detect();
    assert.equal(blocked.ok, false);
    assert.equal(blocked.problem, 'launch-failed');
    assert.ok(blocked.reason && blocked.reason.length > 10);
  } finally {
    b?.cleanup();
    fs.rmSync(work, { recursive: true, force: true });
  }
});

test('설치가 끝나면 연결을 다시 확인하기 전에 beforeRefresh를 먼저 부른다 (막힌 경로를 비우는 자리)', async () => {
  /** @type {string[]} */
  const order = [];
  const setup = createToolSetup({
    root: 'x',
    findBin: () => null,
    installer: { installCodex: async () => ({ ok: true, bin: String.raw`C:\codex.exe`, version: 'codex-cli 1' }) },
    beforeRefresh: () => void order.push('before'),
    refresh: async () => void order.push('refresh'),
  });
  setup.startInstall('codex-cli');
  await new Promise((r) => setImmediate(r));
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(order, ['before', 'refresh']);
});
