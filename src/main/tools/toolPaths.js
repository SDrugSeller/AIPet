// @ts-check
// 앱이 직접 설치한 도구(전용 Node.js, Codex CLI)의 위치. Electron에 의존하지 않는다.
// 모든 것은 한 폴더(userData/tools) 아래에만 둔다: 시스템에 설치하지 않고, 관리자 권한도 PATH 변경도 필요 없으며, 폴더를 지우면 깨끗이 사라진다.
//   <root>/node/          전용 Node.js (node.exe, node_modules/npm)
//   <root>/npm/           npm 전역 설치 위치 (--prefix). 여기에 codex가 설치된다
//   <root>/downloads/     내려받는 중인 파일 (끝나면 지운다)
//   <root>/cache/         npm 캐시 (설치가 끝나면 지운다)
import fs from 'node:fs';
import path from 'node:path';

/** @type {string | null} */
let rootDir = null;

/** 앱 시작 때 한 번 정한다 @param {string | null} dir */
export function configureToolsDir(dir) {
  rootDir = dir;
}

/** 도구 폴더 (정하기 전에는 null) */
export const toolsDir = () => rootDir;

/** @param {string} p */
const isFile = (p) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

/** 전용 Node.js 폴더와 node.exe @param {string} [root] */
export function privateNode(root = rootDir ?? '') {
  const dir = path.join(root, 'node');
  return { dir, exe: path.join(dir, 'node.exe'), npmCli: path.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js') };
}

/** npm 전역 설치 위치 @param {string} [root] */
export const privateNpmPrefix = (root = rootDir ?? '') => path.join(root, 'npm');

/**
 * 앱이 설치한 codex.exe를 찾는다. npm 패키지 안의 네이티브 실행 파일이라 Node 없이 바로 실행된다.
 * 패키지 안의 폴더 구조(버전마다 조금씩 다를 수 있다)에 기대지 않고 @openai 아래를 얕게 훑는다.
 * @param {string} [root] @param {{ arch?: string }} [opts]
 * @returns {string | null}
 */
export function privateCodexBinary(root = rootDir ?? '', { arch = process.arch } = {}) {
  if (!root) return null;
  const base = path.join(privateNpmPrefix(root), 'node_modules', '@openai');
  /** @type {string[]} */
  const found = [];
  /** @param {string} dir @param {number} depth */
  const walk = (dir, depth) => {
    if (depth > 7) return;
    /** @type {fs.Dirent[]} */
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p, depth + 1);
      else if (e.name.toLowerCase() === 'codex.exe') found.push(p);
    }
  };
  walk(base, 0);
  const want = arch === 'arm64' ? 'win32-arm64' : 'win32-x64';
  const hit = found.find((p) => p.includes(want)) ?? found[0];
  return hit && isFile(hit) ? hit : null;
}
