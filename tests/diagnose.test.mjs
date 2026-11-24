// @ts-check
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { classifyProbe, decide, diagnose, maskPrivate } from '../src/main/tools/diagnose.js';
import { createToolSetup } from '../src/main/tools/toolSetup.js';
import { getToolInfo, removeTools } from '../src/main/tools/toolManage.js';

const OK = { code: 0, stdout: 'codex-cli 0.171.0\n', stderr: '' };
const BLOCKED = { code: null, stdout: '', stderr: 'spawn EPERM' };

test('classifyProbe: 실행됨 / 막힘 / 없음 / 실패를 가른다', () => {
  assert.deepEqual(classifyProbe(OK), { state: 'ok', detail: 'codex-cli 0.171.0' });
  assert.equal(classifyProbe(BLOCKED).state, 'blocked');
  assert.equal(classifyProbe({ code: null, stdout: '', stderr: 'Access is denied' }).state, 'blocked');
  assert.equal(classifyProbe({ code: null, stdout: '', stderr: 'spawn x ENOENT' }).state, 'none');
  assert.equal(classifyProbe({ code: 3, stdout: '', stderr: 'boom\nmore' }).state, 'fail');
  assert.match(classifyProbe({ code: 3, stdout: '', stderr: 'boom' }).detail, /종료 코드 3: boom/);
  assert.equal(classifyProbe({ code: null, stdout: '', stderr: 'weird' }).state, 'fail');
});

test('maskPrivate: 사용자 이름이 든 경로를 가린다', () => {
  const t = maskPrivate(String.raw`C:\Users\hong\AppData\Roaming\AIPet\tools and /c/Users/hong/x user=hong`, { home: String.raw`C:\Users\hong`, user: 'hong' });
  assert.doesNotMatch(t, /hong/);
  assert.match(t, /%USERPROFILE%/);
});

/** @param {Partial<Parameters<typeof decide>[0]>} o */
const d = (o) => decide({ tool: 'Codex', candidates: [], login: null, net: [], installable: true, hasCustomPath: false, ...o });
/** @param {string} label @param {'ok' | 'blocked' | 'fail' | 'none'} state @param {boolean} [used] */
const cand = (label, state, used = false) => ({ label, bin: `C:\\${label}`, exists: state !== 'none', state, detail: state, used });
const NET_OK = [{ name: 'a', url: 'u', ok: true, ms: 5, detail: 'HTTP 200' }];
const NET_BAD = [{ name: 'a', url: 'u', ok: false, ms: 5000, detail: 'ENOTFOUND' }];

test('결론: 앱이 쓰는 것이 실행되면 문제 없음, 로그인이 안 됐으면 로그인을 권한다', () => {
  assert.equal(d({ candidates: [cand('PATH', 'ok', true)], login: 'Logged in using ChatGPT' }).level, 'ok');
  const need = d({ candidates: [cand('PATH', 'ok', true)], login: 'Not logged in' });
  assert.equal(need.recommend, 'login');
  assert.equal(need.level, 'warn');
});

test('결론: Store 앱 파일이 막혔고 인터넷이 되면 앱 전용 설치를, 인터넷이 안 되면 설치할 수 없다고 알린다', () => {
  const store = [cand('Codex 데스크톱(Store 앱)', 'blocked', true)];
  const a = d({ candidates: store, net: NET_OK });
  assert.equal(a.recommend, 'install');
  assert.match(a.headline, /막고 있어요/);
  const b = d({ candidates: store, net: NET_BAD });
  assert.equal(b.recommend, null);
  assert.match(b.headline, /인터넷/);
});

test('결론: 앱 전용 설치본까지 막혔으면 정책/백신 문제라고 알리고 설치를 권하지 않는다', () => {
  const r = d({ candidates: [cand('Codex 데스크톱(Store 앱)', 'blocked'), cand('앱 전용 설치본(AIPet이 설치)', 'blocked', true)], net: NET_OK });
  assert.equal(r.recommend, null);
  assert.match(r.headline, /앱 전용 폴더에 설치한 것까지/);
  assert.match(r.advice, /IT 담당자|API 연결/);
});

test('결론: 아무것도 없으면 설치를 권하고(인터넷 되면), 다른 위치의 것은 실행되면 경로 비우기를 권한다', () => {
  assert.equal(d({ candidates: [cand('PATH', 'none')], net: NET_OK }).recommend, 'install');
  assert.equal(d({ candidates: [], net: NET_BAD }).recommend, null);
  const x = d({ candidates: [cand('설정에서 지정한 경로', 'blocked', true), cand('앱 전용 설치본(AIPet이 설치)', 'ok')], hasCustomPath: true });
  assert.equal(x.recommend, 'clear-path');
  assert.equal(d({ candidates: [cand('PATH', 'fail', true)], net: NET_OK }).recommend, 'install');
  assert.equal(d({ candidates: [cand('PATH', 'none')], installable: false }).recommend, null, '설치할 수 없는 도구는 설치를 권하지 않는다');
});

test('diagnose: 후보를 실제로 실행해 보고, 복사용 글에는 개인 경로를 가리며 파일 없는 위치는 한 줄로 묶는다', async () => {
  const home = os.homedir();
  const store = path.join(home, 'WindowsApps', 'codex.exe');
  /** @type {string[]} */
  const probed = [];
  const r = await diagnose({
    tool: 'Codex',
    candidates: [
      { label: 'PATH(터미널에서 쓰는 codex)', bin: path.join(home, 'nope', 'codex.exe') },
      { label: 'Codex 데스크톱(Store 앱)', bin: store },
      { label: '중복', bin: store },
    ],
    currentBin: store,
    loginArgs: ['login', 'status'],
    netTargets: [{ name: 'Node.js(nodejs.org)', url: 'https://nodejs.org/x' }],
    installable: true,
    appVersion: '9.9.9',
    toolsRoot: path.join(home, 'tools'),
    deps: {
      exists: (p) => p === store,
      probe: async (bin, args) => {
        probed.push(`${path.basename(bin)} ${args.join(' ')}`);
        return BLOCKED;
      },
      probeUrl: async () => ({ ok: true, ms: 12, detail: 'HTTP 200' }),
      smartAppControl: () => 1,
      osInfo: () => 'Windows_NT test x64',
      writable: () => true,
      freeMb: () => 50_000,
      env: {},
    },
  });
  assert.deepEqual(probed, ['codex.exe --version'], '있는 파일만, 같은 파일은 한 번만 실행해 본다');
  assert.equal(r.recommend, 'install');
  assert.equal(r.candidates.length, 2);
  assert.match(r.text, /AIPet 9\.9\.9 진단/);
  assert.match(r.text, /\[막힘\] ★앱이 쓰는 것 Codex 데스크톱\(Store 앱\)/);
  assert.match(r.text, /파일이 없는 위치: PATH/);
  assert.match(r.text, /스마트 앱 컨트롤: 켜짐/);
  assert.match(r.text, /\[됨\] Node\.js\(nodejs\.org\)/);
  assert.ok(!r.text.includes(home), '사용자 폴더 경로는 가려진다');
});

test('diagnose: 인터넷이 안 되고 폴더에 쓸 수 없으면 그 이유를 적는다', async () => {
  const r = await diagnose({
    tool: 'Codex',
    candidates: [],
    currentBin: null,
    netTargets: [{ name: 'npm', url: 'https://registry.npmjs.org/x' }],
    installable: true,
    toolsRoot: 'C:\\locked',
    deps: { probeUrl: async () => ({ ok: false, ms: 8000, detail: '8초 안에 응답이 없어요' }), writable: () => false, freeMb: () => 100, smartAppControl: () => null, env: { HTTPS_PROXY: 'http://p' } },
  });
  assert.match(r.headline, /인터넷/);
  assert.match(r.text, /\[안 됨\] npm/);
  assert.match(r.text, /쓸 수 없어요/);
  assert.match(r.text, /프록시 환경변수/);
});

test('removeTools: 앱 전용 폴더 안의 정해진 폴더만 지우고(Codex만 / 전부), 로그인 정보 같은 밖의 것은 건드리지 않는다', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'aipet-rm-'));
  try {
    const root = path.join(base, 'tools');
    for (const n of ['npm', 'cache', 'downloads', 'node']) fs.mkdirSync(path.join(root, n), { recursive: true });
    fs.mkdirSync(path.join(base, 'codex-login'));
    fs.writeFileSync(path.join(base, 'codex-login', 'auth.json'), '{}');
    assert.deepEqual(removeTools(root, 'codex'), { ok: true });
    assert.ok(!fs.existsSync(path.join(root, 'npm')) && fs.existsSync(path.join(root, 'node')), 'Codex만 지우면 전용 Node는 남는다');
    assert.deepEqual(removeTools(root, 'all'), { ok: true });
    assert.ok(!fs.existsSync(path.join(root, 'node')));
    assert.ok(fs.existsSync(path.join(base, 'codex-login', 'auth.json')), '밖의 파일은 그대로');
    assert.equal(removeTools('', 'all').ok, false);
    assert.equal(removeTools('relative/dir', 'all').ok, false);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
});

test('getToolInfo: 설치 여부, 버전, 용량을 돌려준다', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aipet-info-'));
  try {
    const none = await getToolInfo(root, { probe: async () => ({ code: 0, stdout: 'x' }) });
    assert.equal(none.codex.installed, false);
    assert.equal(none.node.installed, false);
    const exe = path.join(root, 'npm', 'node_modules', '@openai', 'codex', 'node_modules', '@openai', 'codex-win32-x64', 'vendor', 'x', 'bin', 'codex.exe');
    fs.mkdirSync(path.dirname(exe), { recursive: true });
    fs.writeFileSync(exe, Buffer.alloc(2 * 1048576));
    fs.mkdirSync(path.join(root, 'node'), { recursive: true });
    fs.writeFileSync(path.join(root, 'node', 'node.exe'), Buffer.alloc(1048576));
    const info = await getToolInfo(root, { arch: 'x64', probe: async (bin) => ({ code: 0, stdout: bin.endsWith('node.exe') ? 'v24.1.0\n' : 'codex-cli 0.171.0\n' }) });
    assert.equal(info.codex.installed, true);
    assert.equal(info.codex.version, 'codex-cli 0.171.0');
    assert.equal(info.codex.sizeMb, 2);
    assert.equal(info.node.version, 'v24.1.0');
    assert.equal(info.totalMb, 3);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('도구 설치 탭: 새로 설치는 clean 옵션으로, 삭제는 다른 작업 중이면 거부하고 끝나면 연결을 다시 확인한다', async () => {
  /** @type {any[]} */
  const calls = [];
  let release = () => {};
  const gate = new Promise((r) => (release = () => r(undefined)));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aipet-tab-'));
  try {
    fs.mkdirSync(path.join(root, 'npm'), { recursive: true });
    let refreshed = 0;
    const setup = createToolSetup({
      root,
      findBin: () => null,
      refresh: async () => void refreshed++,
      installer: { installCodex: async (o = {}) => { calls.push(o.clean); await gate; return { ok: true, bin: 'x', version: 'v' }; } },
    });
    assert.equal(setup.startInstall('codex-cli', { clean: true }), true);
    await new Promise((r) => setImmediate(r));
    assert.deepEqual(calls, [true]);
    const busy = await setup.remove('codex');
    assert.equal(busy.ok, false, '설치하는 중에는 지우지 않는다');
    assert.ok(fs.existsSync(path.join(root, 'npm')));
    release();
    await new Promise((r) => setImmediate(r));
    await new Promise((r) => setImmediate(r));
    const before = refreshed;
    const r = await setup.remove('codex');
    assert.equal(r.ok, true);
    assert.ok(!fs.existsSync(path.join(root, 'npm')));
    assert.equal(refreshed, before + 1, '지운 뒤 연결을 다시 확인한다');
    assert.equal(setup.state().install.phase, 'idle');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
