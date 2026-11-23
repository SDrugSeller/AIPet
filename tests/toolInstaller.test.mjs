// @ts-check
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createInstaller, parseShasums } from '../src/main/tools/installer.js';
import { privateCodexBinary, privateNode } from '../src/main/tools/toolPaths.js';

const ZIP_BYTES = 'fake-node-zip';
const ZIP_SHA = createHash('sha256').update(ZIP_BYTES).digest('hex');
const ZIP_NAME = 'node-v24.22.3-win-x64.zip';
const SUMS = `${'a'.repeat(64)}  node-v24.22.3-linux-x64.tar.xz\n${ZIP_SHA}  ${ZIP_NAME}\n${'b'.repeat(64)}  node-v24.22.3-win-arm64.zip\n`;

/** 임시 도구 폴더 */
function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'aipet-tools-'));
}

/** 네트워크·압축·npm 없이 설치 과정을 흉내 내는 부품들. calls에 무엇을 불렀는지 남는다 */
function fakes(root, { sha = ZIP_SHA, npmCode = 0, npmStderr = '', nodeExists = false } = {}) {
  /** @type {string[]} */
  const calls = [];
  const node = privateNode(root);
  if (nodeExists) {
    fs.mkdirSync(node.dir, { recursive: true });
    fs.writeFileSync(node.exe, '');
  }
  return {
    calls,
    opts: {
      root,
      platform: 'win32',
      arch: 'x64',
      fetchText: async (/** @type {string} */ url) => {
        calls.push(`fetch ${url}`);
        return SUMS;
      },
      download: async (/** @type {{ url: string, dest: string, onProgress?: (a: number, b: number) => void }} */ p) => {
        calls.push(`download ${path.basename(p.url)}`);
        fs.writeFileSync(p.dest, ZIP_BYTES);
        p.onProgress?.(5 * 1048576, 10 * 1048576);
        return sha;
      },
      extractZip: async (/** @type {string} */ _zip, /** @type {string} */ dest) => {
        calls.push('extract');
        const inner = path.join(dest, 'node-v24.22.3-win-x64');
        fs.mkdirSync(path.join(inner, 'node_modules', 'npm', 'bin'), { recursive: true });
        fs.writeFileSync(path.join(inner, 'node.exe'), '');
      },
      runProc: async (/** @type {{ file: string, args: string[] }} */ p) => {
        if (p.args.includes('install')) {
          calls.push(`npm ${p.args.slice(1, 4).join(' ')}`);
          if (npmCode === 0) {
            const exe = path.join(root, 'npm', 'node_modules', '@openai', 'codex', 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x86_64-pc-windows-msvc', 'bin', 'codex.exe');
            fs.mkdirSync(path.dirname(exe), { recursive: true });
            fs.writeFileSync(exe, '');
            fs.mkdirSync(path.join(root, 'cache'), { recursive: true });
          }
          return { code: npmCode, stdout: '', stderr: npmStderr };
        }
        calls.push(`run ${path.basename(p.file)} ${p.args.join(' ')}`);
        return { code: 0, stdout: p.file.endsWith('codex.exe') ? 'codex-cli 0.171.0\n' : 'v24.22.3\n', stderr: '' };
      },
    },
  };
}

test('parseShasums: 이 컴퓨터용 Windows zip의 이름과 해시를 찾는다', () => {
  assert.deepEqual(parseShasums(SUMS, 'win-x64.zip'), { file: ZIP_NAME, sha256: ZIP_SHA });
  assert.equal(parseShasums(SUMS, 'win-arm64.zip')?.file, 'node-v24.22.3-win-arm64.zip');
  assert.equal(parseShasums('garbage', 'win-x64.zip'), null);
  assert.equal(parseShasums(`${'z'.repeat(64)}  ${ZIP_NAME}`, 'win-x64.zip'), null, '해시 형식이 아니면 거부');
});

test('설치: Node.js를 받아 해시를 확인하고 풀고, Codex를 설치해 실행을 확인한 뒤 캐시를 지운다', async () => {
  const root = tmpRoot();
  try {
    const f = fakes(root);
    /** @type {string[]} */
    const steps = [];
    const r = await createInstaller(f.opts).installCodex({ onProgress: (p) => steps.push(p.step) });
    assert.equal(r.ok, true);
    if (!r.ok) return;
    assert.match(r.version, /codex-cli 0\.171/);
    assert.equal(r.bin, privateCodexBinary(root));
    assert.ok(fs.existsSync(privateNode(root).exe), '전용 Node가 풀려 있다');
    assert.ok(!fs.existsSync(path.join(root, 'cache')), '캐시는 지운다');
    assert.ok(!fs.existsSync(path.join(root, 'node-staging')) && !fs.existsSync(path.join(root, 'downloads', ZIP_NAME)), '임시 파일은 지운다');
    assert.deepEqual([...new Set(steps)], ['prepare', 'node-download', 'node-extract', 'codex-install', 'verify']);
    assert.ok(f.calls.includes('fetch https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt'), '공식 사이트에서만 받는다');
    assert.ok(f.calls.some((c) => c.startsWith('npm install -g @openai/codex')));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('설치: 내려받은 파일의 해시가 공식 값과 다르면 쓰지 않는다', async () => {
  const root = tmpRoot();
  try {
    const f = fakes(root, { sha: 'f'.repeat(64) });
    const r = await createInstaller(f.opts).installCodex();
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.step, 'node-verify');
    assert.match(r.reason, /해시/);
    assert.ok(!fs.existsSync(privateNode(root).dir), 'Node를 풀지 않았다');
    assert.ok(!f.calls.includes('extract'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('설치: 이미 실행되는 전용 Node가 있으면 다시 받지 않는다', async () => {
  const root = tmpRoot();
  try {
    const f = fakes(root, { nodeExists: true });
    const r = await createInstaller(f.opts).installCodex();
    assert.equal(r.ok, true);
    assert.ok(!f.calls.some((c) => c.startsWith('fetch') || c.startsWith('download') || c === 'extract'));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('설치: npm이 실패하면 이유를 알려 주고, 네트워크/백신 가능성을 안내한다', async () => {
  const root = tmpRoot();
  try {
    const f = fakes(root, { npmCode: 1, npmStderr: 'npm error code ETIMEDOUT\nnpm error network request failed\nnpm notice update' });
    const r = await createInstaller(f.opts).installCodex();
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.step, 'codex-install');
    assert.match(r.reason, /인터넷|방화벽/);
    assert.match(r.reason, /ETIMEDOUT/);
    assert.doesNotMatch(r.reason, /npm notice/, 'npm의 안내 줄은 빼고 보여 준다');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('설치: 네트워크 오류는 안내 문구로, 취소는 cancelled로 돌려준다', async () => {
  const root = tmpRoot();
  try {
    const f = fakes(root);
    const net = await createInstaller({ ...f.opts, fetchText: async () => { throw new Error('fetch failed'); } }).installCodex();
    assert.equal(net.ok, false);
    if (!net.ok) assert.match(net.reason, /인터넷/);

    const ac = new AbortController();
    const f2 = fakes(root);
    const r = await createInstaller({
      ...f2.opts,
      download: async (/** @type {any} */ p) => {
        fs.writeFileSync(p.dest, ZIP_BYTES);
        ac.abort();
        return ZIP_SHA;
      },
    }).installCodex({ signal: ac.signal });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.cancelled, true);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('설치: Windows가 아니거나 지원하지 않는 CPU면 시작하지 않는다', async () => {
  const root = tmpRoot();
  try {
    const f = fakes(root);
    const linux = await createInstaller({ ...f.opts, platform: 'linux' }).installCodex();
    assert.equal(linux.ok, false);
    const ia32 = await createInstaller({ ...f.opts, arch: 'ia32' }).installCodex();
    assert.equal(ia32.ok, false);
    assert.deepEqual(f.calls, []);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('privateCodexBinary: 설치된 패키지 안에서 내 CPU용 codex.exe를 찾는다', () => {
  const root = tmpRoot();
  try {
    assert.equal(privateCodexBinary(root), null, '설치 전에는 없다');
    assert.equal(privateCodexBinary(''), null);
    const base = path.join(root, 'npm', 'node_modules', '@openai', 'codex', 'node_modules', '@openai');
    for (const a of ['codex-win32-x64', 'codex-win32-arm64']) {
      const p = path.join(base, a, 'vendor', 'x', 'bin', 'codex.exe');
      fs.mkdirSync(path.dirname(p), { recursive: true });
      fs.writeFileSync(p, '');
    }
    assert.match(privateCodexBinary(root, { arch: 'x64' }) ?? '', /codex-win32-x64/);
    assert.match(privateCodexBinary(root, { arch: 'arm64' }) ?? '', /codex-win32-arm64/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
