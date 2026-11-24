// @ts-check
// OpenAI Codex CLI 어댑터. 사용자가 직접 로그인한 공식 `codex` CLI를 `codex exec --json`으로 실행하고
// JSONL 이벤트를 AgentEvent로 변환한다. 앱은 토큰을 보지 않는다.
//
// 안전: 기본은 `--sandbox read-only`로 실행한다. 파일을 읽을 수는 있지만 바꾸지 못하고, exec 모드는 승인 질문을 하지 않는다.
// 설정(permissions.codexWrite)을 켜면 `--sandbox workspace-write`로 실행한다: 작업 폴더 안에서 파일 수정과 명령 실행이
// 승인 없이 되고, 작업 폴더 밖(임시 폴더 제외) 쓰기와 네트워크는 샌드박스가 막는다. exec 모드는 승인 요청을 앱으로 넘기지
// 못하므로 "묻고 진행"은 불가능하고 읽기 전용이거나 자동 실행이거나 둘 중 하나다. 자동 실행한 일은 `trace` 이벤트로 남긴다.
// (항목별 승인 카드와 항목별 자동 허용은 Claude Code 연결에서만 지원한다.)
// 대화 기록은 CLI 세션이 아니라 앱이 프롬프트에 텍스트로 넣어 전달한다 (`--ephemeral`로 세션 파일도 남기지 않는다).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildSystemPrompt, createQueue } from './adapter.js';
import { privateCodexBinary } from '../tools/toolPaths.js';
import { cleanEnv, composePrompt, findOnPath, findStoreAppDirs, isFile, isWin, killTree, launchFailureMessage, MAX_HISTORY_TURNS, readLines, run, spawnCli } from './cli.js';

/** 실행이 막혔을 때 안내할 다른 설치 방법 */
const CODEX_INSTALL = '설정의 "설치하기"로 앱 전용 Codex를 설치하거나, Node.js를 설치한 뒤 cmd에서 npm i -g @openai/codex 로 따로 설치하세요(로그인은 데스크톱 앱과 같아서 다시 할 필요가 없어요)';

/** Codex Desktop(Microsoft Store 앱)이 안에 넣어 둔 codex.exe의 패키지 안 위치 (로그인은 CLI와 같은 ~/.codex를 쓴다) */
const STORE_CODEX_EXE = ['app', 'resources', 'codex.exe'];

/** 마지막으로 찾은 Store 앱의 codex.exe (레지스트리 조회를 매번 하지 않으려는 캐시. 업데이트로 사라지면 다시 찾는다) @type {string | null} */
let storeCodexCache = null;

/**
 * Codex Desktop(Microsoft Store)의 codex.exe를 찾는다. 가장 새 버전부터 본다.
 * @param {(name: string) => string[]} [dirs] 패키지 폴더 조회 (테스트에서 바꿔 끼운다)
 * @returns {string | null}
 */
export function findStoreCodex(dirs = findStoreAppDirs) {
  if (storeCodexCache && isFile(storeCodexCache)) return storeCodexCache;
  storeCodexCache = null;
  for (const dir of dirs('OpenAI.Codex')) {
    const p = path.join(dir, ...STORE_CODEX_EXE);
    if (isFile(p)) return (storeCodexCache = p);
  }
  return null;
}

/** @param {string} [override] 설정에서 지정한 경로. 지정했는데 없으면 null @returns {string | null} */
export function findCodexBinary(override = '') {
  if (override) return isFile(override) ? override : null;
  // 디버그 전용: 설치 안내를 확인하려고 PATH·npm·Store 앱의 codex를 없는 것으로 친다 (앱이 설치한 것은 그대로 보인다)
  const hidden = process.env.AIPET_DEBUG === '1' && process.env.AIPET_CODEX_HIDE === '1';
  if (hidden) return privateCodexBinary();
  const found = findOnPath('codex');
  if (found) return found;
  // npm 전역 설치 위치 (PATH에 없을 때)
  const npmDir = process.env.APPDATA ? path.join(process.env.APPDATA, 'npm') : path.join(os.homedir(), '.npm-global', 'bin');
  for (const name of isWin ? ['codex.cmd', 'codex.exe'] : ['codex']) {
    const p = path.join(npmDir, name);
    if (isFile(p)) return p;
  }
  // 앱이 "설치하기"로 설치한 것 (앱 전용 폴더)
  const own = privateCodexBinary();
  if (own) return own;
  // Codex Desktop(Microsoft Store 앱)만 설치한 경우: 앱 안의 codex.exe를 쓴다
  return isWin ? findStoreCodex() : null;
}

/** Windows에서 Codex가 명령 앞에 붙이는 PowerShell 실행 부분을 떼고, 한 줄로 줄여 보여 준다. @param {unknown} cmd */
export function shortCommand(cmd) {
  let s = String(cmd ?? '').trim();
  s = s.replace(/^"?[^"\s]*powershell(?:\.exe)?"?\s+(?:-\w+\s+)*-Command\s+/i, '');
  if (/^(["']).*\1$/s.test(s)) s = s.slice(1, -1);
  s = (s.split('\n').find((l) => l.trim()) ?? s).trim();
  return s.length > 140 ? `${s.slice(0, 140)}…` : s;
}

/** 파일 변경 종류 표시 */
const KIND_LABEL = { add: '추가', delete: '삭제', update: '수정' };

/**
 * 승인 없이 실행된 일을 대화창에 남길 한 줄로 바꾼다. 해당하지 않는 항목이면 null.
 * @param {any} item
 * @returns {string | null}
 */
function traceOf(item) {
  if (item?.type === 'command_execution' && item.command) return `자동 허용 · 명령 실행 (Codex): ${shortCommand(item.command)}`;
  if (item?.type === 'file_change' && Array.isArray(item.changes) && item.changes.length) {
    const c = item.changes[0];
    const kind = /** @type {Record<string, string>} */ (KIND_LABEL)[String(c?.kind)] ?? '변경';
    const more = item.changes.length > 1 ? ` 외 ${item.changes.length - 1}개` : '';
    return `자동 허용 · 파일 ${kind} (Codex): ${String(c?.path ?? '')}${more}`;
  }
  return null;
}

/**
 * codex exec --json 의 한 줄을 AgentEvent로 바꾼다.
 *  - agent_message(item.completed) = 답변 텍스트, command_execution 등 = 작업 중
 *  - turn.completed = 끝, turn.failed = 실패
 *  - error 이벤트의 "Reconnecting..."은 일시적인 재연결 안내라서 실패로 보지 않는다.
 *  - 쓰기 모드(st.trace)에서는 실행한 명령(command_execution)과 파일 변경(file_change)을 trace 이벤트로 한 번씩 남긴다
 * @typedef {{
 *   sawText: boolean, finished: boolean, lastError: string, text: string, status: string | null,
 *   trace?: boolean, traced?: Set<string>,
 * }} CodexState
 * @param {any} msg @param {CodexState} st
 * @returns {import('./adapter.js').AgentEvent[]}
 */
export function translateCodexLine(msg, st) {
  /** @type {import('./adapter.js').AgentEvent[]} */
  const out = [];
  switch (msg?.type) {
    case 'item.started':
    case 'item.completed': {
      const item = msg.item ?? {};
      const note = st.trace ? traceOf(item) : null;
      if (note && item.id !== undefined) {
        const seen = (st.traced ??= new Set());
        if (!seen.has(String(item.id))) {
          seen.add(String(item.id));
          out.push({ type: 'trace', text: note });
        }
      }
      if (msg.type === 'item.completed' && item.type === 'agent_message' && typeof item.text === 'string' && item.text) {
        const text = (st.sawText ? '\n\n' : '') + item.text;
        st.sawText = true;
        st.text += text;
        out.push({ type: 'text', delta: text });
      } else if (item.type === 'reasoning') {
        if (st.status !== 'thinking') out.push({ type: 'status', state: (st.status = 'thinking') });
      } else if (item.type && item.type !== 'agent_message') {
        if (st.status !== 'working') out.push({ type: 'status', state: (st.status = 'working') });
      }
      break;
    }
    case 'turn.completed':
      st.finished = true;
      out.push({ type: 'done' });
      break;
    case 'turn.failed':
      st.finished = true;
      out.push({ type: 'error', message: String(msg.error?.message ?? msg.message ?? (st.lastError || 'Codex 실행에 실패했어요')) });
      break;
    case 'error': {
      const m = String(msg.message ?? '');
      if (!/^Reconnecting/i.test(m)) st.lastError = m; // 재연결 안내는 무시
      break;
    }
  }
  return out;
}

/**
 * @param {{ getConfig: () => { path: string, model?: string, workDir: string, persona?: string, web?: boolean, write?: boolean } }} opts
 *   write: true면 `--sandbox workspace-write`로 실행한다 (작업 폴더 안 파일 수정·명령 실행을 승인 없이 허용)
 * @returns {import('./adapter.js').AgentAdapter}
 */
export function createCodexCliAdapter({ getConfig }) {
  /** @type {{ role: 'user' | 'assistant', text: string }[]} */
  let history = [];
  /** @type {import('node:child_process').ChildProcess | null} */
  let child = null;
  let aborted = false;

  return {
    id: 'codex-cli',
    label: 'Codex CLI',

    async detect() {
      const cfg = getConfig();
      const bin = findCodexBinary(cfg.path);
      if (!bin) {
        return {
          ok: false,
          problem: cfg.path ? /** @type {const} */ ('bad-path') : /** @type {const} */ ('not-found'),
          reason: cfg.path
            ? '지정한 경로에서 codex를 찾을 수 없어요. 설정에서 경로를 확인해 주세요.'
            : 'codex CLI를 찾을 수 없어요. 설정 → 연결의 "앱 전용으로 설치하기"로 앱이 대신 설치하거나, Codex 데스크톱 앱(Microsoft Store)을 설치하거나 npm i -g @openai/codex로 설치한 뒤 로그인해 주세요.',
        };
      }
      const v = await run(bin, ['--version'], 20000);
      if (v.code !== 0) return { ok: false, ...(v.code === null ? { problem: /** @type {const} */ ('launch-failed') } : {}), reason: v.code === null ? launchFailureMessage('codex', v.stderr, { bin, install: CODEX_INSTALL }) : `codex 실행에 실패했어요: ${(v.stderr || v.stdout).trim().slice(0, 200)}` };
      const login = await run(bin, ['login', 'status'], 20000);
      const status = (login.stdout + login.stderr).trim().split('\n')[0] ?? '';
      if (login.code !== 0) return { ok: false, problem: 'not-logged-in', reason: `codex에 로그인되어 있지 않아요. 터미널에서 codex login을 실행해 주세요. (${status})` };
      const mode = cfg.write
        ? '작업 폴더 샌드박스에서 실행돼요 (파일 수정·명령 실행은 묻지 않고 진행, 작업 폴더 밖 쓰기와 네트워크는 차단)'
        : '읽기 전용으로 실행돼요 (파일을 바꾸지 않아요)';
      return { ok: true, info: `${v.stdout.trim()} · ${bin}\n${status}\n${mode}` };
    },

    send(msg) {
      const queue = createQueue();
      aborted = false;

      (async () => {
        const cfg = getConfig();
        const bin = findCodexBinary(cfg.path);
        if (!bin) {
          queue.push({ type: 'error', message: 'codex CLI를 찾을 수 없어요.' });
          return queue.close();
        }
        fs.mkdirSync(cfg.workDir, { recursive: true });
        const write = !!cfg.write;
        const prompt = composePrompt({ system: buildSystemPrompt(cfg.persona, write ? 'sandbox' : 'readonly', { web: cfg.web }), history, message: msg });
        const args = ['exec', '--json', '--skip-git-repo-check', '--ephemeral', '--sandbox', write ? 'workspace-write' : 'read-only'];
        if (cfg.model) args.push('-m', cfg.model);
        // 웹 검색 허용: 읽기 전용 샌드박스 그대로 모델의 web_search 도구만 켠다. 꺼져 있으면 사용자의 codex 설정을 건드리지 않는다.
        if (cfg.web) args.push('-c', 'web_search="live"');
        args.push('-'); // 프롬프트는 stdin으로 (인자 주입/길이 제한 방지)

        /** @type {CodexState} */
        const st = { sawText: false, finished: false, lastError: '', text: '', status: null, trace: write };
        queue.push({ type: 'status', state: 'thinking' });
        st.status = 'thinking';

        const c = spawnCli(bin, args, { cwd: cfg.workDir, env: cleanEnv(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
        child = c;
        let stderr = '';

        readLines(c.stdout, (line) => {
          let m;
          try {
            m = JSON.parse(line);
          } catch {
            return;
          }
          for (const ev of translateCodexLine(m, st)) queue.push(ev);
        });
        c.stderr?.setEncoding('utf8').on('data', (d) => (stderr = (stderr + d).slice(-2000)));
        c.on('error', (e) => {
          st.finished = true;
          queue.push({ type: 'error', message: launchFailureMessage('codex', e.message, { bin, install: CODEX_INSTALL }) });
          queue.close();
        });
        c.on('close', (code) => {
          if (st.finished && st.text) history = [...history, { role: 'user', text: msg }, { role: 'assistant', text: st.text }].slice(-MAX_HISTORY_TURNS * 2);
          if (!st.finished && !aborted) {
            const tail = stderr.split('\n').filter((l) => l.trim() && !/^\d{4}-\d\d-\d\dT/.test(l)).slice(-2).join(' ');
            queue.push({ type: 'error', message: st.lastError || tail || `codex가 종료되었어요 (코드 ${code})` });
          }
          child = null;
          queue.close();
        });

        c.stdin?.on('error', () => {});
        c.stdin?.end(prompt);
      })();

      return queue;
    },

    respondPermission() {
      // exec 모드는 읽기 전용이든 workspace-write든 승인 질문을 앱으로 넘기지 않는다 (자동 실행하거나 샌드박스가 막는다).
    },

    abort() {
      aborted = true;
      killTree(child);
    },

    reset() {
      history = [];
    },
  };
}
