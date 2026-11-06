// @ts-check
// OpenAI Codex CLI 어댑터. 사용자가 직접 로그인한 공식 `codex` CLI를 `codex exec --json`으로 실행하고
// JSONL 이벤트를 AgentEvent로 변환한다. 앱은 토큰을 보지 않는다.
//
// 안전: 항상 `--sandbox read-only`로 실행한다. 파일을 읽을 수는 있지만 바꾸지 못하고, exec 모드는 승인 질문을 하지 않는다.
// (쓰기/명령 실행 + 승인 카드는 Claude Code 연결에서만 지원한다.)
// 대화 기록은 CLI 세션이 아니라 앱이 프롬프트에 텍스트로 넣어 전달한다 (`--ephemeral`로 세션 파일도 남기지 않는다).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildSystemPrompt, createQueue } from './adapter.js';
import { cleanEnv, composePrompt, findOnPath, isFile, isWin, killTree, MAX_HISTORY_TURNS, readLines, run, spawnCli } from './cli.js';

/** @param {string} [override] 설정에서 지정한 경로. 지정했는데 없으면 null @returns {string | null} */
export function findCodexBinary(override = '') {
  if (override) return isFile(override) ? override : null;
  const found = findOnPath('codex');
  if (found) return found;
  // npm 전역 설치 위치 (PATH에 없을 때)
  const npmDir = process.env.APPDATA ? path.join(process.env.APPDATA, 'npm') : path.join(os.homedir(), '.npm-global', 'bin');
  for (const name of isWin ? ['codex.cmd', 'codex.exe'] : ['codex']) {
    const p = path.join(npmDir, name);
    if (isFile(p)) return p;
  }
  return null;
}

/**
 * codex exec --json 의 한 줄을 AgentEvent로 바꾼다.
 *  - agent_message(item.completed) = 답변 텍스트, command_execution 등 = 작업 중
 *  - turn.completed = 끝, turn.failed = 실패
 *  - error 이벤트의 "Reconnecting..."은 일시적인 재연결 안내라서 실패로 보지 않는다.
 * @typedef {{ sawText: boolean, finished: boolean, lastError: string, text: string, status: string | null }} CodexState
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
 * @param {{ getConfig: () => { path: string, model?: string, workDir: string, persona?: string } }} opts
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
          reason: cfg.path
            ? '지정한 경로에서 codex를 찾을 수 없어요. 설정에서 경로를 확인해 주세요.'
            : 'codex CLI를 찾을 수 없어요. 설치(npm i -g @openai/codex) 후 터미널에서 codex login으로 로그인해 주세요.',
        };
      }
      const v = await run(bin, ['--version'], 20000);
      if (v.code !== 0) return { ok: false, reason: `codex 실행에 실패했어요: ${(v.stderr || v.stdout).trim().slice(0, 200)}` };
      const login = await run(bin, ['login', 'status'], 20000);
      const status = (login.stdout + login.stderr).trim().split('\n')[0] ?? '';
      if (login.code !== 0) return { ok: false, reason: `codex에 로그인되어 있지 않아요. 터미널에서 codex login을 실행해 주세요. (${status})` };
      return { ok: true, info: `${v.stdout.trim()} · ${bin}\n${status}\n읽기 전용으로 실행돼요 (파일을 바꾸지 않아요)` };
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
        const prompt = composePrompt({ system: buildSystemPrompt(cfg.persona, 'readonly', { web: cfg.web }), history, message: msg });
        const args = ['exec', '--json', '--skip-git-repo-check', '--ephemeral', '--sandbox', 'read-only'];
        if (cfg.model) args.push('-m', cfg.model);
        // 웹 검색 허용: 읽기 전용 샌드박스 그대로 모델의 web_search 도구만 켠다. 꺼져 있으면 사용자의 codex 설정을 건드리지 않는다.
        if (cfg.web) args.push('-c', 'web_search="live"');
        args.push('-'); // 프롬프트는 stdin으로 (인자 주입/길이 제한 방지)

        /** @type {CodexState} */
        const st = { sawText: false, finished: false, lastError: '', text: '', status: null };
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
          queue.push({ type: 'error', message: `codex 실행에 실패했어요: ${e.message}` });
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
      // read-only 샌드박스 + exec 모드: 승인 질문이 발생하지 않는다.
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
