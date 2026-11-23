// @ts-check
// Codex CLI를 앱 전용 폴더에 설치한다 (일반 사용자가 cmd나 npm을 몰라도 되도록). Electron에 의존하지 않고, 네트워크·프로세스·압축 해제는
// 바꿔 끼울 수 있게 해서 테스트한다.
//
// 순서: ① 공식 사이트(nodejs.org)에서 Node.js(LTS) 압축 파일을 받고 공식 해시(SHASUMS256.txt)와 맞는지 확인해 앱 전용 폴더에 푼다
//       ② 그 Node의 npm으로 @openai/codex를 앱 전용 폴더에 설치한다 (npm 레지스트리의 무결성 검사는 npm이 한다)
//       ③ 설치된 codex.exe가 실행되는지 확인하고, 캐시를 지운다.
// 시스템에 설치하지 않으므로 관리자 권한이 필요 없고 PATH도 바꾸지 않는다. 받는 곳은 nodejs.org와 npm 레지스트리뿐이다.
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { launchFailureMessage, killTree } from '../agent/cli.js';
import { privateCodexBinary, privateNode, privateNpmPrefix } from './toolPaths.js';

/** 설치할 Node.js 메이저 버전 (LTS). 이 줄의 최신 버전을 받는다 */
export const NODE_MAJOR = 24;
const NODE_BASE = `https://nodejs.org/dist/latest-v${NODE_MAJOR}.x/`;
const CODEX_PACKAGE = '@openai/codex';
const NPM_TIMEOUT_MS = 20 * 60_000;

/**
 * SHASUMS256.txt에서 Windows용 zip의 파일 이름과 해시를 찾는다.
 * @param {string} text @param {string} suffix 예: 'win-x64.zip'
 * @returns {{ file: string, sha256: string } | null}
 */
export function parseShasums(text, suffix) {
  for (const line of text.split(/\r?\n/)) {
    const m = line.trim().match(/^([0-9a-f]{64})\s+(node-v[\d.]+-([\w-]+\.zip))$/i);
    if (m && m[3].toLowerCase() === suffix) return { file: m[2], sha256: m[1].toLowerCase() };
  }
  return null;
}

/** @typedef {{ step: string, message: string, percent: number | null }} InstallProgress */
/** @typedef {{ ok: true, bin: string, version: string } | { ok: false, step: string, reason: string, cancelled?: boolean }} InstallResult */
/** @typedef {{ code: number | null, stdout: string, stderr: string, error?: string, aborted?: boolean }} ProcResult */

/** @param {string} url @param {AbortSignal} [signal] */
async function defaultFetchText(url, signal) {
  const res = await fetch(url, { signal });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

/**
 * 파일을 내려받으면서 SHA-256을 계산한다. nodejs.org의 https 주소만 받는다.
 * @param {{ url: string, dest: string, signal?: AbortSignal, onProgress?: (received: number, total: number) => void }} p
 * @returns {Promise<string>} sha256
 */
async function defaultDownload({ url, dest, signal, onProgress }) {
  if (!url.startsWith('https://nodejs.org/')) throw new Error('허용하지 않는 주소예요');
  const res = await fetch(url, { signal });
  if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const hash = createHash('sha256');
  const out = fs.createWriteStream(dest);
  let received = 0;
  let lastTick = 0;
  try {
    for await (const chunk of /** @type {any} */ (res.body)) {
      hash.update(chunk);
      received += chunk.length;
      if (!out.write(chunk)) await new Promise((r) => out.once('drain', r));
      const now = Date.now();
      if (now - lastTick > 250) {
        lastTick = now;
        onProgress?.(received, total);
      }
    }
    onProgress?.(received, total);
  } finally {
    await new Promise((r) => out.end(r));
  }
  return hash.digest('hex');
}

/**
 * 프로세스를 실행하고 끝날 때까지 기다린다. 출력은 끝부분만 모은다. signal로 중단하면 하위 프로세스까지 끝낸다.
 * @param {{ file: string, args: string[], env?: NodeJS.ProcessEnv, cwd?: string, signal?: AbortSignal, timeoutMs?: number }} p
 * @returns {Promise<ProcResult>}
 */
function defaultRunProc({ file, args, env, cwd, signal, timeoutMs = 120_000 }) {
  return new Promise((resolve) => {
    const e = { ...(env ?? process.env) };
    delete e.ELECTRON_RUN_AS_NODE;
    let child;
    try {
      child = spawn(file, args, { env: e, cwd, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      return resolve({ code: null, stdout: '', stderr: '', error: String(/** @type {Error} */ (err).message) });
    }
    let stdout = '';
    let stderr = '';
    let done = false;
    const finish = (/** @type {ProcResult} */ r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(r);
    };
    const onAbort = () => {
      killTree(child);
      finish({ code: null, stdout, stderr, aborted: true });
    };
    const timer = setTimeout(() => {
      killTree(child);
      finish({ code: null, stdout, stderr, error: '시간이 너무 오래 걸려서 멈췄어요' });
    }, timeoutMs);
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout?.setEncoding('utf8').on('data', (d) => (stdout = (stdout + d).slice(-8000)));
    child.stderr?.setEncoding('utf8').on('data', (d) => (stderr = (stderr + d).slice(-8000)));
    child.on('error', (err) => finish({ code: null, stdout, stderr, error: err.message }));
    child.on('close', (code) => finish({ code, stdout, stderr }));
  });
}

/** Windows에 들어 있는 tar(bsdtar)로 zip을 푼다 @param {string} zip @param {string} destDir @param {AbortSignal} [signal] */
async function defaultExtractZip(zip, destDir, signal) {
  const tar = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe');
  const r = await defaultRunProc({ file: tar, args: ['-xf', zip, '-C', destDir], signal, timeoutMs: 5 * 60_000 });
  if (r.code !== 0) throw new Error(r.error ?? (r.stderr.trim() || `tar 종료 코드 ${r.code}`));
}

/** @param {unknown} e */
const messageOf = (e) => String(/** @type {Error} */ (e)?.message ?? e);

/**
 * 설치기를 만든다.
 * @param {{
 *   root: string,
 *   platform?: string,
 *   arch?: string,
 *   fetchText?: typeof defaultFetchText,
 *   download?: typeof defaultDownload,
 *   extractZip?: typeof defaultExtractZip,
 *   runProc?: typeof defaultRunProc,
 * }} opts
 */
export function createInstaller({
  root,
  platform = process.platform,
  arch = process.arch,
  fetchText = defaultFetchText,
  download = defaultDownload,
  extractZip = defaultExtractZip,
  runProc = defaultRunProc,
}) {
  /**
   * Codex를 설치(이미 있으면 최신으로 다시 설치)한다.
   * @param {{ signal?: AbortSignal, onProgress?: (p: InstallProgress) => void }} [opts]
   * @returns {Promise<InstallResult>}
   */
  async function installCodex({ signal, onProgress = () => {} } = {}) {
    /** @param {string} step @param {string} reason @returns {InstallResult} */
    const fail = (step, reason) => ({ ok: false, step, reason, ...(signal?.aborted ? { cancelled: true, reason: '설치를 취소했어요' } : {}) });
    /** @param {string} step @param {string} message @param {number | null} [percent] */
    const say = (step, message, percent = null) => onProgress({ step, message, percent });

    if (platform !== 'win32') return fail('unsupported', '이 설치 기능은 Windows에서만 쓸 수 있어요');
    if (arch !== 'x64' && arch !== 'arm64') return fail('unsupported', `이 컴퓨터(${arch})는 지원하지 않아요`);

    const node = privateNode(root);
    const prefix = privateNpmPrefix(root);
    const downloads = path.join(root, 'downloads');
    const cache = path.join(root, 'cache');
    const suffix = arch === 'arm64' ? 'win-arm64.zip' : 'win-x64.zip';

    try {
      say('prepare', '준비하는 중…');
      fs.mkdirSync(downloads, { recursive: true });

      // ① 전용 Node.js: 이미 있고 실행되면 그대로 쓴다
      const have = fs.existsSync(node.exe) ? await runProc({ file: node.exe, args: ['--version'], signal, timeoutMs: 20_000 }) : null;
      if (signal?.aborted) return fail('prepare', '');
      if (!have || have.code !== 0) {
        say('node-download', 'Node.js 정보를 확인하는 중…');
        const sums = await fetchText(`${NODE_BASE}SHASUMS256.txt`, signal);
        const entry = parseShasums(sums, suffix);
        if (!entry) return fail('node-download', 'Node.js 내려받기 정보를 찾지 못했어요. 잠시 뒤에 다시 시도해 주세요');

        const zip = path.join(downloads, entry.file);
        const part = `${zip}.part`;
        const mb = (/** @type {number} */ n) => (n / 1048576).toFixed(0);
        const sha = await download({
          url: `${NODE_BASE}${entry.file}`,
          dest: part,
          signal,
          onProgress: (got, total) => say('node-download', total ? `Node.js 내려받는 중… ${mb(got)} / ${mb(total)}MB` : `Node.js 내려받는 중… ${mb(got)}MB`, total ? Math.min(99, Math.round((got / total) * 100)) : null),
        });
        if (signal?.aborted) return fail('node-download', '');
        if (sha.toLowerCase() !== entry.sha256) {
          fs.rmSync(part, { force: true });
          return fail('node-verify', '내려받은 Node.js 파일이 공식 해시와 달라서 쓰지 않았어요. 네트워크(회사 방화벽·프록시)가 파일을 바꿨을 수 있어요');
        }
        fs.renameSync(part, zip);

        say('node-extract', 'Node.js를 앱 전용 폴더에 푸는 중…');
        const staging = path.join(root, 'node-staging');
        fs.rmSync(staging, { recursive: true, force: true });
        fs.mkdirSync(staging, { recursive: true });
        await extractZip(zip, staging, signal);
        if (signal?.aborted) return fail('node-extract', '');
        const inner = fs.readdirSync(staging, { withFileTypes: true }).find((d) => d.isDirectory() && fs.existsSync(path.join(staging, d.name, 'node.exe')));
        if (!inner) return fail('node-extract', 'Node.js 압축 파일 안에서 node.exe를 찾지 못했어요');
        fs.rmSync(node.dir, { recursive: true, force: true });
        fs.renameSync(path.join(staging, inner.name), node.dir);
        fs.rmSync(staging, { recursive: true, force: true });
        fs.rmSync(zip, { force: true });
        const check = await runProc({ file: node.exe, args: ['--version'], signal, timeoutMs: 20_000 });
        if (check.code !== 0) return fail('node-extract', launchFailureMessage('node', check.error ?? check.stderr, { bin: node.exe }));
      }

      // ② Codex CLI를 앱 전용 폴더에 설치
      const started = Date.now();
      say('codex-install', 'Codex를 설치하는 중… (몇 분 걸릴 수 있어요)');
      const tick = setInterval(() => say('codex-install', `Codex를 설치하는 중… ${Math.round((Date.now() - started) / 1000)}초 (몇 분 걸릴 수 있어요)`), 2000);
      /** @type {ProcResult} */
      let npm;
      try {
        npm = await runProc({
          file: node.exe,
          args: [node.npmCli, 'install', '-g', CODEX_PACKAGE, '--prefix', prefix, '--cache', cache, '--no-fund', '--no-audit', '--loglevel=error', '--update-notifier=false'],
          env: { ...process.env, PATH: `${node.dir}${path.delimiter}${process.env.PATH ?? ''}` },
          signal,
          timeoutMs: NPM_TIMEOUT_MS,
        });
      } finally {
        clearInterval(tick);
      }
      if (signal?.aborted) return fail('codex-install', '');
      if (npm.code !== 0) {
        const tail = (npm.error ?? npm.stderr).split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !/^npm notice/i.test(l)).slice(-3).join(' ').slice(0, 300);
        if (/\b(EPERM|EACCES)\b/.test(tail)) return fail('codex-install', launchFailureMessage('npm', tail, { bin: node.exe }));
        return fail('codex-install', `Codex 설치에 실패했어요. 인터넷 연결(회사 방화벽·프록시)이나 백신이 막았을 수 있어요.${tail ? ` (${tail})` : ''}`);
      }

      // ③ 확인
      say('verify', '설치를 확인하는 중…');
      const bin = privateCodexBinary(root, { arch });
      if (!bin) return fail('verify', '설치는 끝났는데 codex.exe를 찾지 못했어요');
      const v = await runProc({ file: bin, args: ['--version'], signal, timeoutMs: 30_000 });
      if (signal?.aborted) return fail('verify', '');
      if (v.code !== 0) return fail('verify', launchFailureMessage('codex', v.error ?? v.stderr, { bin, install: '' }));
      fs.rmSync(cache, { recursive: true, force: true });
      return { ok: true, bin, version: v.stdout.trim() };
    } catch (e) {
      if (signal?.aborted) return fail('cancelled', '');
      const msg = messageOf(e);
      if (/fetch failed|ENOTFOUND|ETIMEDOUT|ECONNRESET|ECONNREFUSED|HTTP \d+|network/i.test(msg)) {
        return fail('network', `인터넷에 연결하지 못했어요. 연결이나 회사 방화벽·프록시를 확인해 주세요. (${msg})`);
      }
      return fail('error', `설치 중 문제가 생겼어요: ${msg}`);
    }
  }

  return { installCodex };
}
