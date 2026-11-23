// @ts-check
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { findStoreCodex } from '../src/main/agent/codexCliAdapter.js';
import { findStoreAppDirs } from '../src/main/agent/cli.js';

const KEY = String.raw`HKEY_CURRENT_USER\Software\Classes\Local Settings\Software\Microsoft\Windows\CurrentVersion\AppModel\Repository\Packages`;

/** reg.exe 출력을 흉내 낸다: 패키지 이름 목록과 이름별 설치 폴더 @param {Record<string, string>} roots 패키지 전체 이름 → 설치 폴더 */
function fakeReg(roots) {
  /** @param {string[]} args */
  return (args) => {
    if (args.includes('/f')) {
      const lines = Object.keys(roots).map((n) => `${KEY}\\${n}`);
      return `\r\n${lines.join('\r\n')}\r\n\r\nEnd of search: ${lines.length} match(es) found.\r\n`;
    }
    const full = args[1].split('\\').pop() ?? '';
    return roots[full] ? `\r\n${args[1]}\r\n    PackageRootFolder    REG_SZ    ${roots[full]}\r\n\r\n` : '';
  };
}

const OLD = 'OpenAI.Codex_26.1020.1.0_x64__2p2nqsd0c76g0';
const NEW = 'OpenAI.Codex_26.1111.9664.0_x64__2p2nqsd0c76g0';
const ROOTS = {
  [OLD]: `C:\\Program Files\\WindowsApps\\${OLD}`,
  [NEW]: `C:\\Program Files\\WindowsApps\\${NEW}`,
};

test('Store 앱: 설치된 패키지의 폴더를 새 버전부터 돌려준다', () => {
  const dirs = findStoreAppDirs('OpenAI.Codex', { reg: fakeReg(ROOTS), platform: 'win32', arch: 'x64' });
  assert.deepEqual(dirs, [ROOTS[NEW], ROOTS[OLD]]);
});

test('Store 앱: 버전은 숫자로 비교하고(9 < 10), 내 CPU 구조에 맞는 패키지를 먼저 둔다', () => {
  const a = 'OpenAI.Codex_26.9.0.0_x64__2p2nqsd0c76g0';
  const b = 'OpenAI.Codex_26.10.0.0_x64__2p2nqsd0c76g0';
  const c = 'OpenAI.Codex_99.0.0.0_arm64__2p2nqsd0c76g0';
  const roots = { [a]: 'C:\\a', [b]: 'C:\\b', [c]: 'C:\\c' };
  assert.deepEqual(findStoreAppDirs('OpenAI.Codex', { reg: fakeReg(roots), platform: 'win32', arch: 'x64' }), ['C:\\b', 'C:\\a', 'C:\\c']);
  assert.equal(findStoreAppDirs('OpenAI.Codex', { reg: fakeReg(roots), platform: 'win32', arch: 'arm64' })[0], 'C:\\c');
});

test('Store 앱: 설치돼 있지 않거나(빈 출력) 다른 OS이거나 이름이 이상하면 빈 배열', () => {
  assert.deepEqual(findStoreAppDirs('OpenAI.Codex', { reg: () => '', platform: 'win32' }), []);
  assert.deepEqual(findStoreAppDirs('OpenAI.Codex', { reg: fakeReg(ROOTS), platform: 'linux' }), []);
  assert.deepEqual(findStoreAppDirs('a" /v x', { reg: fakeReg(ROOTS), platform: 'win32' }), []);
});

test('Store 앱: 이름이 비슷한 다른 패키지는 섞이지 않는다', () => {
  const other = 'OpenAI.CodexHelper_1.0.0.0_x64__2p2nqsd0c76g0';
  assert.deepEqual(findStoreAppDirs('OpenAI.Codex', { reg: fakeReg({ [other]: 'C:\\other' }), platform: 'win32' }), []);
});

test('findStoreCodex: 패키지 폴더 안의 app/resources/codex.exe를 찾고, 새 버전에 없으면 이전 버전을 본다', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'aipet-store-'));
  try {
    const newer = path.join(tmp, 'new');
    const older = path.join(tmp, 'old');
    fs.mkdirSync(newer, { recursive: true });
    fs.mkdirSync(path.join(older, 'app', 'resources'), { recursive: true });
    const exe = path.join(older, 'app', 'resources', 'codex.exe');
    fs.writeFileSync(exe, '');
    assert.equal(findStoreCodex(() => [newer, older]), exe);
    assert.equal(findStoreCodex(() => []), exe, '한 번 찾은 곳은 파일이 남아 있는 동안 그대로 쓴다');
    fs.rmSync(exe);
    assert.equal(findStoreCodex(() => [newer]), null, '파일이 사라지면(업데이트 등) 다시 찾는다');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
