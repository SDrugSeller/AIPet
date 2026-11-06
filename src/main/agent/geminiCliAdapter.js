// @ts-check
// Google Gemini CLI 어댑터. 사용자가 직접 로그인한 공식 `gemini` CLI를 헤드리스(`-p`)로 실행하고
// `--output-format stream-json` 이벤트를 AgentEvent로 변환한다. 앱은 토큰/키를 보지 않는다.
//
// 안전: `--approval-mode plan`(읽기 전용)으로 실행해 파일을 바꾸거나 명령을 실행하지 못한다.
// 대화 기록은 CLI 세션이 아니라 앱이 프롬프트에 텍스트로 넣어 전달한다.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildSystemPrompt, createQueue } from './adapter.js';
import { cleanEnv, composePrompt, findOnPath, isFile, isWin, killTree, MAX_HISTORY_TURNS, readLines, run, spawnCli } from './cli.js';

/** @param {string} [override] 설정에서 지정한 경로. 지정했는데 없으면 null @returns {string | null} */
export function findGeminiBinary(override = '') {
  if (override) return isFile(override) ? override : null;
  const found = findOnPath('gemini');
  if (found) return found;
  const npmDir = process.env.APPDATA ? path.join(process.env.APPDATA, 'npm') : path.join(os.homedir(), '.npm-global', 'bin');
  for (const name of isWin ? ['gemini.cmd', 'gemini.exe'] : ['gemini']) {
    const p = path.join(npmDir, name);
    if (isFile(p)) return p;
  }
  return null;
}

/** 로그인(OAuth) 또는 API 키 환경변수가 있는가. 확인할 수 없으면 null (CLI가 다른 방법으로 설정돼 있을 수 있다) */
function authHint() {
  const e = process.env;
  if (e.GEMINI_API_KEY || e.GOOGLE_API_KEY || e.GOOGLE_GENAI_USE_VERTEXAI || e.GOOGLE_GENAI_USE_GCA) return 'API 키/환경변수';
  if (isFile(path.join(os.homedir(), '.gemini', 'oauth_creds.json'))) return '로그인된 Google 계정';
  return null;
}

/** 사용자에게 보여 줄 오류 문장으로 다듬는다 (CLI의 오류는 JSON 문자열이 통째로 들어올 때가 많다). @param {string} raw */
export function friendlyGeminiError(raw) {
  if (/API key not valid|API_KEY_INVALID/i.test(raw)) return 'Gemini API 키가 올바르지 않아요.';
  if (/Please set an Auth method|authentication|not logged in/i.test(raw)) return 'Gemini에 로그인되어 있지 않아요. 터미널에서 gemini를 실행해 로그인하거나 GEMINI_API_KEY를 설정해 주세요.';
  if (/quota|RESOURCE_EXHAUSTED|429/i.test(raw)) return 'Gemini 사용량 한도에 걸렸어요. 잠시 뒤에 다시 시도해 주세요.';
  const inner = /"message"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(raw);
  const text = (inner ? inner[1].replace(/\\n/g, ' ').replace(/\\"/g, '"') : raw).replace(/\s+/g, ' ').trim();
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}

/**
 * gemini --output-format stream-json 의 한 줄을 AgentEvent로 바꾼다.
 *  - message(role=assistant, delta) = 답변 텍스트 조각, tool_use = 작업 중
 *  - result(status=success|error) = 끝
 * @typedef {{ finished: boolean, lastError: string, text: string, status: string | null }} GeminiState
 * @param {any} msg @param {GeminiState} st
 * @returns {import('./adapter.js').AgentEvent[]}
 */
export function translateGeminiLine(msg, st) {
  /** @type {import('./adapter.js').AgentEvent[]} */
  const out = [];
  switch (msg?.type) {
    case 'message':
      if (msg.role === 'assistant' && typeof msg.content === 'string' && msg.content) {
        st.text += msg.content;
        out.push({ type: 'text', delta: msg.content });
      }
      break;
    case 'tool_use':
      if (st.status !== 'working') out.push({ type: 'status', state: (st.status = 'working') });
      break;
    case 'error':
      if (msg.severity !== 'warning') st.lastError = String(msg.message ?? '');
      break;
    case 'result':
      st.finished = true;
      if (msg.status === 'error') out.push({ type: 'error', message: friendlyGeminiError(String(msg.error?.message ?? st.lastError ?? 'Gemini 실행에 실패했어요')) });
      else out.push({ type: 'done' });
      break;
  }
  return out;
}

/**
 * @param {{ getConfig: () => { path: string, model?: string, workDir: string, persona?: string } }} opts
 * @returns {import('./adapter.js').AgentAdapter}
 */
export function createGeminiCliAdapter({ getConfig }) {
  /** @type {{ role: 'user' | 'assistant', text: string }[]} */
  let history = [];
  /** @type {import('node:child_process').ChildProcess | null} */
  let child = null;
  let aborted = false;

  return {
    id: 'gemini-cli',
    label: 'Gemini CLI',

    async detect() {
      const cfg = getConfig();
      const bin = findGeminiBinary(cfg.path);
      if (!bin) {
        return {
          ok: false,
          reason: cfg.path
            ? '지정한 경로에서 gemini를 찾을 수 없어요. 설정에서 경로를 확인해 주세요.'
            : 'gemini CLI를 찾을 수 없어요. 설치(npm i -g @google/gemini-cli) 후 터미널에서 gemini로 로그인해 주세요.',
        };
      }
      const v = await run(bin, ['--version'], 30000);
      if (v.code !== 0) return { ok: false, reason: `gemini 실행에 실패했어요: ${(v.stderr || v.stdout).trim().slice(0, 200)}` };
      // gemini에는 로그인 상태를 알려 주는 명령이 없다. 흔적이 없어도 다른 방식으로 설정했을 수 있어 막지는 않는다.
      const auth = authHint();
      const authLine = auth ? `인증: ${auth}` : '로그인 상태를 확인하지 못했어요 (안 되면 터미널에서 gemini로 로그인하거나 GEMINI_API_KEY를 설정해 주세요)';
      return { ok: true, info: `gemini ${v.stdout.trim()} · ${bin}\n${authLine}\n읽기 전용(plan 모드)으로 실행돼요` };
    },

    send(msg) {
      const queue = createQueue();
      aborted = false;

      (async () => {
        const cfg = getConfig();
        const bin = findGeminiBinary(cfg.path);
        if (!bin) {
          queue.push({ type: 'error', message: 'gemini CLI를 찾을 수 없어요.' });
          return queue.close();
        }
        fs.mkdirSync(cfg.workDir, { recursive: true });
        const prompt = composePrompt({ system: buildSystemPrompt(cfg.persona, 'readonly', { web: cfg.web }), history, message: msg });
        // 긴 프롬프트는 stdin으로 보내고, -p에는 짧은 값만 준다 (stdin 뒤에 덧붙는다).
        const args = ['-p', 'Please respond.', '--output-format', 'stream-json', '--approval-mode', 'plan', '--skip-trust'];
        if (cfg.model) args.push('-m', cfg.model);

        /** @type {GeminiState} */
        const st = { finished: false, lastError: '', text: '', status: null };
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
          for (const ev of translateGeminiLine(m, st)) queue.push(ev);
        });
        c.stderr?.setEncoding('utf8').on('data', (d) => (stderr = (stderr + d).slice(-2000)));
        c.on('error', (e) => {
          st.finished = true;
          queue.push({ type: 'error', message: `gemini 실행에 실패했어요: ${e.message}` });
          queue.close();
        });
        c.on('close', (code) => {
          if (st.finished && st.text) history = [...history, { role: 'user', text: msg }, { role: 'assistant', text: st.text }].slice(-MAX_HISTORY_TURNS * 2);
          if (!st.finished && !aborted) {
            queue.push({ type: 'error', message: friendlyGeminiError(st.lastError || stderr.trim() || `gemini가 종료되었어요 (코드 ${code})`) });
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
      // plan(읽기 전용) 모드라 승인 질문이 발생하지 않는다.
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
