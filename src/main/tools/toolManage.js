// @ts-check
// "도구 설치" 탭이 쓰는 관리 기능: 앱 전용 설치본의 상태 보기와 지우기. Electron에 의존하지 않는다.
// 지우는 것은 앱 전용 폴더(userData/tools) 안뿐이다. 로그인 정보(~/.codex 등)는 그 밖에 있어서 건드리지 않는다.
import fs from 'node:fs';
import path from 'node:path';
import { run } from '../agent/cli.js';
import { privateCodexBinary, privateNode, privateNpmPrefix } from './toolPaths.js';

/** 폴더 크기(MB). 없으면 0. 큰 폴더라 메인 프로세스를 오래 붙잡지 않게 비동기로 읽는다 @param {string} dir */
export async function dirSizeMb(dir) {
  let total = 0;
  /** @param {string} d */
  const walk = async (d) => {
    /** @type {fs.Dirent[]} */
    let entries;
    try {
      entries = await fs.promises.readdir(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) await walk(p);
      else {
        try {
          total += (await fs.promises.stat(p)).size;
        } catch {
          // 읽는 사이에 사라진 파일
        }
      }
    }
  };
  await walk(dir);
  return Math.round(total / 1048576);
}

/**
 * 앱 전용 설치본의 상태.
 * @param {string} root
 * @param {{ probe?: (bin: string, args: string[]) => Promise<{ code: number | null, stdout: string }>, arch?: string }} [deps]
 */
export async function getToolInfo(root, { probe = (bin, args) => run(bin, args, 15000), arch = process.arch } = {}) {
  const bin = privateCodexBinary(root, { arch });
  const node = privateNode(root);
  const nodeInstalled = fs.existsSync(node.exe);
  /** @type {string} */
  let codexVersion = '';
  if (bin) {
    const r = await probe(bin, ['--version']);
    codexVersion = r.code === 0 ? r.stdout.trim() : '';
  }
  let nodeVersion = '';
  if (nodeInstalled) {
    const r = await probe(node.exe, ['--version']);
    nodeVersion = r.code === 0 ? r.stdout.trim() : '';
  }
  const [codexMb, nodeMb, totalMb] = await Promise.all([dirSizeMb(privateNpmPrefix(root)), dirSizeMb(node.dir), dirSizeMb(root)]);
  return {
    dir: root,
    codex: { installed: !!bin, runnable: !!codexVersion, version: codexVersion, bin: bin ?? '', sizeMb: codexMb },
    node: { installed: nodeInstalled, version: nodeVersion, sizeMb: nodeMb },
    totalMb,
  };
}

/**
 * 앱 전용 설치본을 지운다. scope 'codex'는 Codex(와 내려받기 찌꺼기)만, 'all'은 전용 Node.js까지 지운다.
 * 폴더 이름을 코드가 정하고 root 안인지 확인하므로, 다른 곳은 지우지 않는다.
 * @param {string} root @param {'codex' | 'all'} scope
 * @returns {{ ok: true } | { ok: false, reason: string }}
 */
export function removeTools(root, scope) {
  if (!root || !path.isAbsolute(root)) return { ok: false, reason: '도구 폴더를 알 수 없어요' };
  const names = scope === 'all' ? ['npm', 'cache', 'downloads', 'node', 'node-staging'] : ['npm', 'cache', 'downloads'];
  for (const name of names) {
    const target = path.join(root, name);
    const rel = path.relative(root, target);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return { ok: false, reason: '허용하지 않는 경로예요' };
    try {
      fs.rmSync(target, { recursive: true, force: true });
    } catch (e) {
      return { ok: false, reason: `지우지 못했어요: Codex를 쓰는 중이거나 백신이 잡고 있을 수 있어요. 잠시 뒤에 다시 시도해 주세요. (${/** @type {Error} */ (e).message})` };
    }
  }
  return { ok: true };
}
