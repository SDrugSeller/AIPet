// @ts-check
// CLI 어댑터들이 함께 쓰는 도구: 실행 파일 찾기, 서브프로세스 실행/종료, 짧은 명령 실행.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

export const isWin = process.platform === 'win32';

/** @param {string} p */
export const isFile = (p) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

/**
 * PATH에서 실행 파일을 찾는다. Windows에서는 .exe를 먼저, npm 전역 설치가 만드는 .cmd 셔임도 찾는다.
 * @param {string} name  예: 'codex'
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string | null}
 */
export function findOnPath(name, env = process.env) {
  const exts = isWin ? ['.exe', '.cmd'] : [''];
  for (const dir of (env.PATH ?? env.Path ?? '').split(path.delimiter)) {
    if (!dir) continue;
    for (const ext of exts) {
      const p = path.join(dir, name + ext);
      if (isFile(p)) return p;
    }
  }
  return null;
}

/** Microsoft Store(MSIX) 앱의 설치 정보가 있는 레지스트리 키 (현재 사용자 기준, 관리자 권한이 필요 없다) */
const STORE_PACKAGES_KEY = String.raw`HKCU\Software\Classes\Local Settings\Software\Microsoft\Windows\CurrentVersion\AppModel\Repository\Packages`;

/** reg.exe를 실행해 출력을 돌려준다. 실패하면 빈 문자열. @param {string[]} args */
function regQuery(args) {
  try {
    return execFileSync('reg', args, { encoding: 'utf8', windowsHide: true, timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return '';
  }
}

/** "26.1111.9664.0" 같은 버전을 숫자로 비교한다 (새 버전이 앞) @param {string} a @param {string} b */
function compareVersionsDesc(a, b) {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pb[i] || 0) - (pa[i] || 0);
    if (d) return d;
  }
  return 0;
}

/**
 * Microsoft Store로 설치한 앱의 폴더들을 새 버전부터 돌려준다. Store 앱은 PATH에 등록되지 않고 WindowsApps 폴더는
 * 목록을 볼 수 없어서, 레지스트리의 패키지 목록에서 찾는다. 다른 OS이거나 설치되어 있지 않으면 빈 배열.
 * @param {string} name 패키지 이름 (예: 'OpenAI.Codex')
 * @param {{ reg?: (args: string[]) => string, platform?: string, arch?: string }} [opts] 테스트에서 바꿔 끼운다
 * @returns {string[]}
 */
export function findStoreAppDirs(name, { reg = regQuery, platform = process.platform, arch = process.arch } = {}) {
  if (platform !== 'win32' || !/^[A-Za-z0-9.]+$/.test(name)) return [];
  const listing = reg(['query', STORE_PACKAGES_KEY, '/f', `${name}_`, '/k']);
  /** @type {{ full: string, version: string, rank: number }[]} */
  const found = [];
  for (const line of listing.split(/\r?\n/)) {
    // 이름_버전_아키텍처_리소스_게시자해시 (예: OpenAI.Codex_26.1111.9664.0_x64__2p2nqsd0c76g0)
    const m = line.trim().match(/[\\/]((?:[A-Za-z0-9.]+)_(\d+(?:\.\d+)*)_(\w+)_[^_\\/\s]*_[A-Za-z0-9]+)$/);
    if (!m || !m[1].startsWith(`${name}_`)) continue;
    const want = arch === 'arm64' ? 'arm64' : 'x64';
    found.push({ full: m[1], version: m[2], rank: m[3] === want ? 0 : m[3] === 'neutral' ? 1 : 2 });
  }
  found.sort((a, b) => a.rank - b.rank || compareVersionsDesc(a.version, b.version));
  /** @type {string[]} */
  const dirs = [];
  for (const { full } of found) {
    const v = reg(['query', `${STORE_PACKAGES_KEY}\\${full}`, '/v', 'PackageRootFolder']);
    const root = v.match(/PackageRootFolder\s+REG_SZ\s+(.+?)\s*$/m)?.[1];
    if (root) dirs.push(root);
  }
  return dirs;
}

/** cmd.exe용 인자 인용 (.cmd 셔임 실행 시에만 사용) @param {string} s */
const quoteWin = (s) => (/^[\w@%+=:,./\\-]+$/.test(s) ? s : `"${s.replace(/"/g, '""')}"`);

/**
 * 서브프로세스를 띄운다. .cmd/.bat 셔임은 셸이 필요하다.
 * 사용자 입력은 절대 인자로 넘기지 않고 stdin으로만 보낸다 (인자 주입/길이 제한 방지).
 * @param {string} bin @param {string[]} args @param {import('node:child_process').SpawnOptions} opts
 */
export function spawnCli(bin, args, opts) {
  if (/\.(cmd|bat)$/i.test(bin)) {
    return spawn([bin, ...args].map(quoteWin).join(' '), { ...opts, shell: true });
  }
  return spawn(bin, args, opts);
}

/**
 * 자식 프로세스에 넘길 환경변수. Electron 전용 변수는 빼고, 필요한 값을 덧붙인다.
 * @param {Record<string, string>} [extra]
 */
export function cleanEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

/**
 * 프로세스(와 그 자식들)를 끝낸다. Windows의 .cmd 셔임은 cmd.exe 아래에 node가 따로 떠 있어서
 * child.kill()만으로는 안쪽 프로세스가 남는다.
 * @param {import('node:child_process').ChildProcess | null} child
 */
export function killTree(child) {
  if (!child || child.killed || child.exitCode !== null) return;
  if (isWin && child.pid) {
    spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }).on('error', () => child.kill());
  } else {
    child.kill();
  }
}

/**
 * 짧게 끝나는 명령을 실행해 출력을 모은다.
 * @param {string} bin @param {string[]} args @param {number} timeoutMs @param {Record<string, string>} [extraEnv]
 * @returns {Promise<{ code: number | null, stdout: string, stderr: string }>}
 */
export function run(bin, args, timeoutMs, extraEnv = {}) {
  return new Promise((resolve) => {
    const child = spawnCli(bin, args, { env: cleanEnv(extraEnv), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => killTree(child), timeoutMs);
    child.stdout?.setEncoding('utf8').on('data', (d) => (stdout += d));
    child.stderr?.setEncoding('utf8').on('data', (d) => (stderr += d));
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: String(e.message) });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

/**
 * 줄 단위로 읽어 콜백에 넘긴다 (UTF-8 글자가 청크 경계에서 깨지지 않게 처리).
 * @param {import('node:stream').Readable | null | undefined} stream @param {(line: string) => void} onLine
 */
export function readLines(stream, onLine) {
  let buf = '';
  stream?.setEncoding('utf8').on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).replace(/\r$/, '').trim();
      buf = buf.slice(i + 1);
      if (line) onLine(line);
    }
  });
  stream?.on('end', () => {
    const rest = buf.trim();
    buf = '';
    if (rest) onLine(rest);
  });
}

/** 대화 기록(최근 N개)을 CLI에 줄 프롬프트 텍스트로 만든다. CLI는 세션을 앱이 직접 이어 주지 않으므로 기록을 텍스트로 전달한다. */
export const MAX_HISTORY_TURNS = 10;

/**
 * 말투 지침 + 이전 대화 + 새 메시지를 하나의 프롬프트로 합친다.
 * @param {{ system: string, history: { role: 'user' | 'assistant', text: string }[], message: string }} p
 */
export function composePrompt({ system, history, message }) {
  const parts = [`[지침]\n${system}`];
  if (history.length) {
    parts.push(`[이전 대화]\n${history.map((h) => `${h.role === 'user' ? '사용자' : '펫'}: ${h.text}`).join('\n')}`);
  }
  parts.push(`[사용자의 새 메시지]\n${message}`);
  return parts.join('\n\n');
}
