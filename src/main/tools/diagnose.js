// @ts-check
// "원인 진단": 연결(CLI)이 안 될 때 어디서 막히는지 실제로 해 보고 알려 준다. Electron에 의존하지 않고, 실행·네트워크·레지스트리는
// 바꿔 끼울 수 있게 해서 테스트한다.
//
// 하는 일: ① 후보 실행 파일(설정 경로, PATH, npm 전역, 앱 전용 설치본, Store 앱 …)을 하나씩 `--version`으로 실행해 본다
//         ② 로그인 상태 확인 ③ 앱 전용 폴더·작업 폴더의 쓰기 가능 여부와 남은 용량 ④ 인터넷 접속 시험 ⑤ Windows/보안 정보
//         → 사람이 읽는 결론 한 줄(headline)과 자세한 내용(text, 복사해서 보낼 수 있음)을 만든다.
// 개인 정보: 대화 내용과 토큰은 다루지 않는다. 사용자 이름이 든 경로는 %USERPROFILE%로 바꾼다.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { findOnPath, findStoreAppDirs, run } from '../agent/cli.js';
import { privateCodexBinary } from './toolPaths.js';

/** 후보 하나의 결과 상태: ok(실행됨) | blocked(Windows가 막음) | fail(실행했지만 실패) | none(파일 없음) */
/** @typedef {{ label: string, bin: string, exists: boolean, state: 'ok' | 'blocked' | 'fail' | 'none', detail: string, used: boolean }} Candidate */
/** @typedef {{ name: string, url: string, ok: boolean, ms: number, detail: string }} NetCheck */
/**
 * @typedef {{
 *   tool: string, level: 'ok' | 'warn' | 'bad', headline: string, advice: string,
 *   recommend: 'install' | 'login' | 'clear-path' | null,
 *   candidates: Candidate[], login: string | null, net: NetCheck[], notes: string[], text: string,
 * }} Diagnosis
 */

const BLOCKED = /\b(EPERM|EACCES)\b|access is denied|operation not permitted/i;

/** 실행 결과를 상태로 바꾼다 @param {{ code: number | null, stdout: string, stderr: string }} r @returns {{ state: Candidate['state'], detail: string }} */
export function classifyProbe(r) {
  const first = (s) => s.trim().split(/\r?\n/)[0]?.trim().slice(0, 160) ?? '';
  if (r.code === 0) return { state: 'ok', detail: first(r.stdout) || '실행됨' };
  if (r.code === null) {
    const text = (r.stderr || '').trim();
    if (BLOCKED.test(text)) return { state: 'blocked', detail: `Windows가 실행을 거부했어요 (${first(text)})` };
    if (/\bENOENT\b/.test(text)) return { state: 'none', detail: '파일을 찾을 수 없어요' };
    return { state: 'fail', detail: first(text) || '실행하지 못했어요' };
  }
  return { state: 'fail', detail: `종료 코드 ${r.code}: ${first(r.stderr || r.stdout)}` };
}

/** 경로의 사용자 이름을 가린다 @param {string} text @param {{ home?: string, user?: string }} [who] */
export function maskPrivate(text, { home = os.homedir(), user = safeUser() } = {}) {
  let t = text;
  if (home) t = t.split(home).join('%USERPROFILE%').split(home.replace(/\\/g, '/')).join('%USERPROFILE%');
  if (user && user.length > 1) t = t.replace(new RegExp(user.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), '<사용자>');
  return t;
}

function safeUser() {
  try {
    return os.userInfo().username;
  } catch {
    return '';
  }
}

/** 스마트 앱 컨트롤 상태(0 꺼짐, 1 켜짐, 2 평가 중). 읽을 수 없으면 null @returns {number | null} */
function readSmartAppControl() {
  try {
    const out = execFileSync('reg', ['query', String.raw`HKLM\SYSTEM\CurrentControlSet\Control\CI\Policy`, '/v', 'VerifiedAndReputablePolicyState'], { encoding: 'utf8', windowsHide: true, timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] });
    const m = out.match(/VerifiedAndReputablePolicyState\s+REG_DWORD\s+0x([0-9a-f]+)/i);
    return m ? parseInt(m[1], 16) : null;
  } catch {
    return null;
  }
}

/** 주소에 접속해 본다 (어떤 HTTP 응답이든 오면 접속은 된 것) @param {string} url @param {number} [timeoutMs] */
async function probeUrl(url, timeoutMs = 8000) {
  const t0 = Date.now();
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  try {
    const res = await fetch(url, { method: 'HEAD', signal: ac.signal });
    return { ok: true, ms: Date.now() - t0, detail: `HTTP ${res.status}` };
  } catch (e) {
    const msg = ac.signal.aborted ? `${timeoutMs / 1000}초 안에 응답이 없어요` : String(/** @type {Error} */ (e).cause?.code ?? /** @type {Error} */ (e).message ?? e);
    return { ok: false, ms: Date.now() - t0, detail: msg };
  } finally {
    clearTimeout(timer);
  }
}

/** @param {string} dir @returns {boolean} */
function writable(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const f = path.join(dir, `.aipet-write-test-${process.pid}`);
    fs.writeFileSync(f, 'x');
    fs.rmSync(f, { force: true });
    return true;
  } catch {
    return false;
  }
}

/** 남은 용량(MB). 알 수 없으면 null @param {string} dir */
function freeMb(dir) {
  try {
    let d = dir;
    while (d && !fs.existsSync(d)) d = path.dirname(d);
    const s = fs.statfsSync(d);
    return Math.round((Number(s.bavail) * Number(s.bsize)) / 1048576);
  } catch {
    return null;
  }
}

/** @param {string} p */
const isFile = (p) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

/**
 * 결론을 정한다: 후보들의 결과와 네트워크 결과를 보고 무엇이 문제이고 무엇을 하면 되는지.
 * @param {{ tool: string, candidates: Candidate[], login: string | null, net: NetCheck[], installable: boolean, hasCustomPath: boolean }} p
 * @returns {{ level: 'ok' | 'warn' | 'bad', headline: string, advice: string, recommend: Diagnosis['recommend'] }}
 */
export function decide({ tool, candidates, login, net, installable, hasCustomPath }) {
  const used = candidates.find((c) => c.used);
  const running = candidates.filter((c) => c.state === 'ok');
  const blocked = candidates.filter((c) => c.state === 'blocked');
  const netOk = net.length === 0 || net.every((n) => n.ok);
  const own = candidates.find((c) => c.label.startsWith('앱 전용'));

  if (used?.state === 'ok') {
    if (login !== null && /not logged|로그인.*(안|필요)|not authenticated/i.test(login)) {
      return { level: 'warn', headline: `${tool}는 실행되지만 로그인이 필요해요.`, advice: '"로그인하기"(또는 터미널에서 로그인)를 한 뒤 "다시 확인"을 눌러 주세요.', recommend: 'login' };
    }
    return { level: 'ok', headline: `문제를 찾지 못했어요. ${tool}가 정상으로 실행돼요.`, advice: '그래도 안 되면 아래 자세한 내용을 복사해서 보내 주세요.', recommend: null };
  }
  if (running.length) {
    const r = running[0];
    return {
      level: 'warn',
      headline: `앱이 쓰는 ${tool}는 안 되지만, 다른 위치의 것은 실행돼요 (${r.label}).`,
      advice: hasCustomPath ? '설정의 "실행 파일 경로"를 비우면(자동 탐지) 실행되는 쪽을 쓸 수 있어요.' : '"다시 확인"을 눌러 보세요. 계속되면 자세한 내용을 복사해서 보내 주세요.',
      recommend: hasCustomPath ? 'clear-path' : null,
    };
  }
  if (blocked.length) {
    if (own?.state === 'blocked') {
      return {
        level: 'bad',
        headline: '앱 전용 폴더에 설치한 것까지 Windows가 막고 있어요.',
        advice: '회사·학교 PC의 보안 정책이나 백신이 원인일 가능성이 커요. IT 담당자에게 AIPet 폴더(%APPDATA%/AIPet)의 실행 허용을 요청하거나, 외부 프로그램이 필요 없는 API 연결을 쓰세요.',
        recommend: null,
      };
    }
    const where = blocked.map((b) => b.label).join(', ');
    if (installable && netOk) return { level: 'bad', headline: `Windows가 ${tool} 실행을 막고 있어요 (${where}).`, advice: '"앱 전용으로 설치하기"로 다른 위치에 새로 설치해 보세요. 그래도 막히면 회사 정책이나 백신이 원인이에요.', recommend: 'install' };
    if (installable) return { level: 'bad', headline: `Windows가 ${tool} 실행을 막고 있고(${where}), 인터넷에도 접속하지 못해 새로 설치할 수 없어요.`, advice: '인터넷 연결(회사 방화벽·프록시)을 확인해 주세요.', recommend: null };
    return { level: 'bad', headline: `Windows가 ${tool} 실행을 막고 있어요 (${where}).`, advice: '백신이나 보안 프로그램에서 AIPet과 그 CLI의 실행을 허용해 주세요. 회사 PC라면 IT 담당자에게 문의하세요.', recommend: null };
  }
  const failing = candidates.find((c) => c.state === 'fail');
  if (failing) {
    return { level: 'bad', headline: `${tool}가 있지만 실행에 실패해요 (${failing.label}).`, advice: `${failing.detail}. 다시 설치하면 해결될 수 있어요.`, recommend: installable ? 'install' : null };
  }
  if (installable) {
    if (netOk) return { level: 'bad', headline: `${tool}를 찾지 못했어요.`, advice: '"앱 전용으로 설치하기"를 누르면 앱이 대신 설치해 줘요.', recommend: 'install' };
    return { level: 'bad', headline: `${tool}가 없고 인터넷에도 접속하지 못해 설치할 수 없어요.`, advice: '인터넷 연결(회사 방화벽·프록시)을 확인한 뒤 다시 시도해 주세요.', recommend: null };
  }
  return { level: 'bad', headline: `${tool}를 찾지 못했어요.`, advice: `${tool}를 설치한 뒤 로그인하고 "다시 확인"을 눌러 주세요.`, recommend: null };
}

/**
 * 진단을 실행한다.
 * @param {{
 *   tool: string,
 *   candidates: { label: string, bin: string }[],
 *   currentBin: string | null,
 *   loginArgs?: string[],
 *   netTargets?: { name: string, url: string }[],
 *   installable?: boolean,
 *   hasCustomPath?: boolean,
 *   toolsRoot?: string,
 *   workDir?: string,
 *   appVersion?: string,
 *   deps?: {
 *     probe?: (bin: string, args: string[]) => Promise<{ code: number | null, stdout: string, stderr: string }>,
 *     probeUrl?: typeof probeUrl,
 *     exists?: (p: string) => boolean,
 *     smartAppControl?: () => number | null,
 *     osInfo?: () => string,
 *     writable?: typeof writable,
 *     freeMb?: typeof freeMb,
 *     env?: NodeJS.ProcessEnv,
 *   },
 * }} p
 * @returns {Promise<Diagnosis>}
 */
export async function diagnose({ tool, candidates, currentBin, loginArgs, netTargets = [], installable = false, hasCustomPath = false, toolsRoot = '', workDir = '', appVersion = '', deps = {} }) {
  const probe = deps.probe ?? ((bin, args) => run(bin, args, 15000));
  const exists = deps.exists ?? isFile;
  const probeNet = deps.probeUrl ?? probeUrl;
  const env = deps.env ?? process.env;
  const lc = (/** @type {string} */ s) => s.toLowerCase();

  // ① 후보를 하나씩 실행해 본다 (같은 파일이 여러 번 나오면 한 번만)
  /** @type {Candidate[]} */
  const results = [];
  const seen = new Set();
  for (const c of candidates) {
    if (!c.bin || seen.has(lc(c.bin))) continue;
    seen.add(lc(c.bin));
    const used = !!currentBin && lc(currentBin) === lc(c.bin);
    if (!exists(c.bin)) {
      results.push({ label: c.label, bin: c.bin, exists: false, state: 'none', detail: '파일이 없어요', used });
      continue;
    }
    const { state, detail } = classifyProbe(await probe(c.bin, ['--version']));
    results.push({ label: c.label, bin: c.bin, exists: true, state, detail, used });
  }

  // ② 로그인 상태 (실행되는 것 중 앱이 쓰는 것, 없으면 첫 번째). 상태 한 줄만 읽고 토큰은 보지 않는다
  /** @type {string | null} */
  let login = null;
  const runner = results.find((c) => c.used && c.state === 'ok') ?? results.find((c) => c.state === 'ok');
  if (runner && loginArgs) {
    const r = await probe(runner.bin, loginArgs);
    login = `${(r.stdout + r.stderr).trim().split(/\r?\n/)[0] ?? ''}`.slice(0, 120) || (r.code === 0 ? '확인됨' : `종료 코드 ${r.code}`);
    if (r.code !== 0 && !/not|로그인|login/i.test(login)) login = `확인하지 못했어요 (${login})`;
  }

  // ③ 인터넷
  /** @type {NetCheck[]} */
  const net = [];
  for (const t of netTargets) {
    const r = await probeNet(t.url);
    net.push({ name: t.name, url: t.url, ok: r.ok, ms: r.ms, detail: r.detail });
  }

  // ④ 환경
  const notes = [];
  const write = deps.writable ?? writable;
  const free = deps.freeMb ?? freeMb;
  if (toolsRoot) {
    const ok = write(toolsRoot);
    const mb = free(toolsRoot);
    notes.push(`앱 전용 폴더: ${toolsRoot} — 쓰기 ${ok ? '가능' : '불가'}${mb !== null ? `, 남은 용량 ${mb.toLocaleString('en-US')}MB` : ''}`);
    if (!ok) notes.push('⚠ 앱 전용 폴더에 쓸 수 없어요. 설치가 안 되는 원인이 될 수 있어요.');
    else if (mb !== null && mb < 1500) notes.push('⚠ 남은 디스크 용량이 적어요 (설치에는 약 600MB가 필요해요).');
  }
  if (workDir) notes.push(`작업 폴더: ${workDir} — 쓰기 ${write(workDir) ? '가능' : '불가 (대화가 시작되지 않을 수 있어요)'}`);
  const sac = (deps.smartAppControl ?? readSmartAppControl)();
  notes.push(`스마트 앱 컨트롤: ${sac === null ? '알 수 없음' : sac === 1 ? '켜짐 (서명이 없거나 평판이 낮은 프로그램을 막을 수 있어요)' : sac === 2 ? '평가 중' : '꺼짐'}`);
  const proxy = ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy'].some((k) => !!env[k]);
  if (proxy) notes.push('프록시 환경변수가 설정되어 있어요.');

  const verdict = decide({ tool, candidates: results, login, net, installable, hasCustomPath });

  // 복사해서 보낼 글
  const mark = { ok: '실행됨', blocked: '막힘', fail: '실패', none: '없음' };
  const lines = [
    `AIPet ${appVersion || '?'} 진단 (${tool}) — ${new Date().toISOString().slice(0, 19).replace('T', ' ')}`,
    `환경: ${(deps.osInfo ?? (() => `${os.type()} ${os.release()} ${os.arch()}`))()}`,
    '',
    `결론: ${verdict.headline}`,
    `권장: ${verdict.advice}`,
    '',
    '후보 실행 파일 (앱이 찾는 순서):',
    ...results.filter((c) => c.exists).map((c) => `  [${mark[c.state]}]${c.used ? ' ★앱이 쓰는 것' : ''} ${c.label}: ${c.bin} — ${c.detail}`),
    ...(results.some((c) => c.exists) ? [] : ['  (실행할 수 있는 파일을 하나도 찾지 못했어요)']),
    ...(results.some((c) => !c.exists) ? [`  파일이 없는 위치: ${[...new Set(results.filter((c) => !c.exists).map((c) => c.label))].join(', ')}`] : []),
    ...(login !== null ? ['', `로그인 상태: ${login}`] : []),
    ...(net.length ? ['', '인터넷 접속:', ...net.map((n) => `  [${n.ok ? '됨' : '안 됨'}] ${n.name} (${n.url}) — ${n.detail}, ${n.ms}ms`)] : []),
    '',
    ...notes,
  ];
  const text = maskPrivate(lines.join('\n'));
  return { tool, ...verdict, candidates: results, login, net, notes, text };
}

// --- 도구별 후보 목록 ---

/**
 * Codex 후보: 설정 경로 → PATH → npm 전역 → 앱 전용 설치본 → Store 앱 (앱이 찾는 순서와 같다)
 * @param {{ configPath: string, toolsRoot: string, storeExe: string[], env?: NodeJS.ProcessEnv }} p
 */
export function codexCandidates({ configPath, toolsRoot, storeExe, env = process.env }) {
  /** @type {{ label: string, bin: string }[]} */
  const out = [];
  if (configPath) out.push({ label: '설정에서 지정한 경로', bin: configPath });
  out.push({ label: 'PATH(터미널에서 쓰는 codex)', bin: findOnPath('codex', env) ?? '' });
  const npmDir = env.APPDATA ? path.join(env.APPDATA, 'npm') : path.join(os.homedir(), '.npm-global', 'bin');
  for (const name of ['codex.cmd', 'codex.exe']) out.push({ label: 'npm 전역 설치', bin: path.join(npmDir, name) });
  out.push({ label: '앱 전용 설치본(AIPet이 설치)', bin: privateCodexBinary(toolsRoot) ?? '' });
  for (const dir of findStoreAppDirs('OpenAI.Codex')) out.push({ label: 'Codex 데스크톱(Store 앱)', bin: path.join(dir, ...storeExe) });
  return out.filter((c) => c.bin);
}

/** Claude Code 후보: 설정 경로 → PATH → 공식 설치 위치 → VS Code 확장에 든 바이너리 @param {{ configPath: string, env?: NodeJS.ProcessEnv }} p */
export function claudeCandidates({ configPath, env = process.env }) {
  /** @type {{ label: string, bin: string }[]} */
  const out = [];
  if (configPath) out.push({ label: '설정에서 지정한 경로', bin: configPath });
  out.push({ label: 'PATH(터미널에서 쓰는 claude)', bin: findOnPath('claude', env) ?? '' });
  const home = os.homedir();
  out.push({ label: '공식 설치 위치(.local/bin)', bin: path.join(home, '.local', 'bin', 'claude.exe') });
  out.push({ label: '공식 설치 위치(.claude/local)', bin: path.join(home, '.claude', 'local', 'claude.exe') });
  try {
    const extDir = path.join(home, '.vscode', 'extensions');
    const dirs = fs.readdirSync(extDir).filter((d) => d.startsWith('anthropic.claude-code-')).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    if (dirs[0]) out.push({ label: 'VS Code 확장에 든 것', bin: path.join(extDir, dirs[0], 'resources', 'native-binary', 'claude.exe') });
  } catch {
    // 확장 폴더 없음
  }
  return out.filter((c) => c.bin);
}

/** Gemini CLI 후보: 설정 경로 → PATH → npm 전역 @param {{ configPath: string, env?: NodeJS.ProcessEnv }} p */
export function geminiCandidates({ configPath, env = process.env }) {
  /** @type {{ label: string, bin: string }[]} */
  const out = [];
  if (configPath) out.push({ label: '설정에서 지정한 경로', bin: configPath });
  out.push({ label: 'PATH(터미널에서 쓰는 gemini)', bin: findOnPath('gemini', env) ?? '' });
  const npmDir = env.APPDATA ? path.join(env.APPDATA, 'npm') : path.join(os.homedir(), '.npm-global', 'bin');
  for (const name of ['gemini.cmd', 'gemini.exe']) out.push({ label: 'npm 전역 설치', bin: path.join(npmDir, name) });
  return out.filter((c) => c.bin);
}

