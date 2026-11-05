// @ts-check
// Claude Code CLI 어댑터. 사용자가 직접 로그인한 공식 `claude` CLI를 서브프로세스로 실행하고
// `--output-format stream-json` 출력을 AgentEvent로 변환한다. 앱은 토큰을 보지 않는다. (DESIGN.md 4.2/4.3)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createQueue, PERSONA } from './adapter.js';

const isWin = process.platform === 'win32';
const exe = isWin ? '.exe' : '';

/** @param {string} p */
const isFile = (p) => {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
};

/**
 * `claude` 실행 파일을 찾는다. 순서: AIPET_CLAUDE_PATH → PATH → 공식 설치 위치 → VS Code 확장에 포함된 바이너리.
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string | null}
 */
export function findClaudeBinary(env = process.env) {
  if (env.AIPET_CLAUDE_PATH) return isFile(env.AIPET_CLAUDE_PATH) ? env.AIPET_CLAUDE_PATH : null;

  const names = isWin ? [`claude${exe}`, 'claude.cmd'] : ['claude'];
  for (const dir of (env.PATH ?? env.Path ?? '').split(path.delimiter)) {
    if (!dir) continue;
    for (const n of names) {
      const p = path.join(dir, n);
      if (isFile(p)) return p;
    }
  }

  const home = os.homedir();
  for (const p of [
    path.join(home, '.local', 'bin', `claude${exe}`),
    path.join(home, '.claude', 'local', `claude${exe}`),
  ]) {
    if (isFile(p)) return p;
  }

  // VS Code Claude Code 확장에 번들된 공식 바이너리 (가장 높은 버전)
  try {
    const extDir = path.join(home, '.vscode', 'extensions');
    const dirs = fs
      .readdirSync(extDir)
      .filter((d) => d.startsWith('anthropic.claude-code-'))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    for (const d of dirs) {
      const p = path.join(extDir, d, 'resources', 'native-binary', `claude${exe}`);
      if (isFile(p)) return p;
    }
  } catch {
    // 확장 폴더 없음
  }
  return null;
}

/** cmd.exe용 인자 인용 (.cmd 셔임 실행 시에만 사용) @param {string} s */
const quoteWin = (s) => (/^[\w@%+=:,./\\-]+$/.test(s) ? s : `"${s.replace(/"/g, '""')}"`);

/** .cmd/.bat 셔임은 셸이 필요하다. 사용자 입력은 인자로 넘기지 않고 stdin으로만 보낸다. */
/** @param {string} bin @param {string[]} args @param {import('node:child_process').SpawnOptions} opts */
function spawnCli(bin, args, opts) {
  if (/\.(cmd|bat)$/i.test(bin)) {
    return spawn([bin, ...args].map(quoteWin).join(' '), { ...opts, shell: true });
  }
  return spawn(bin, args, opts);
}

/** 자식 프로세스에 넘길 환경변수 (Electron 전용 변수는 제거) */
function cleanEnv() {
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  return env;
}

/**
 * 짧게 끝나는 명령을 실행해 출력을 모은다.
 * @param {string} bin @param {string[]} args @param {number} timeoutMs
 * @returns {Promise<{ code: number | null, stdout: string, stderr: string }>}
 */
function run(bin, args, timeoutMs) {
  return new Promise((resolve) => {
    const child = spawnCli(bin, args, { env: cleanEnv(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => child.kill(), timeoutMs);
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
 * stream-json 한 줄(JSON 객체)을 AgentEvent 목록으로 바꾼다. 상태(st)는 한 번의 send 동안 유지된다.
 * @typedef {{ sawDelta: boolean, finished: boolean, status: string | null, sessionId: string | null }} StreamState
 * @param {any} msg @param {StreamState} st
 * @returns {import('./adapter.js').AgentEvent[]}
 */
export function translateClaudeMessage(msg, st) {
  /** @type {import('./adapter.js').AgentEvent[]} */
  const out = [];
  if (typeof msg?.session_id === 'string') st.sessionId = msg.session_id;

  /** @param {'thinking' | 'working'} state */
  const status = (state) => {
    if (st.status !== state) {
      st.status = state;
      out.push({ type: 'status', state });
    }
  };

  switch (msg?.type) {
    case 'stream_event': {
      const e = msg.event;
      if (e?.type === 'content_block_start') {
        const t = e.content_block?.type;
        if (t === 'thinking' || t === 'redacted_thinking') status('thinking');
        else if (t === 'tool_use' || t === 'server_tool_use') status('working');
      } else if (e?.type === 'content_block_delta' && e.delta?.type === 'text_delta' && e.delta.text) {
        st.sawDelta = true;
        out.push({ type: 'text', delta: e.delta.text });
      }
      break;
    }
    case 'assistant': {
      // --include-partial-messages가 동작하면 델타로 이미 받았다. 아닐 때만 완성된 메시지를 쓴다.
      if (!st.sawDelta) {
        for (const b of msg.message?.content ?? []) {
          if (b.type === 'text' && b.text) out.push({ type: 'text', delta: b.text });
          else if (b.type === 'tool_use') status('working');
        }
      }
      break;
    }
    case 'result': {
      st.finished = true;
      if (msg.is_error) out.push({ type: 'error', message: String(msg.result || msg.subtype || '알 수 없는 오류') });
      else out.push({ type: 'done' });
      break;
    }
  }
  return out;
}

/**
 * @param {{ workDir: string }} opts
 *   workDir: 펫 전용 작업 폴더. 사용자의 프로젝트와 대화 기록이 섞이지 않게 여기서만 실행한다.
 * @returns {import('./adapter.js').AgentAdapter}
 */
export function createClaudeCodeAdapter({ workDir }) {
  fs.mkdirSync(workDir, { recursive: true });
  const personaFile = path.join(workDir, 'persona.txt');
  fs.writeFileSync(personaFile, PERSONA, 'utf8');

  /** @type {string | null} 이어서 대화하기 위한 세션 ID */
  let sessionId = null;
  /** @type {import('node:child_process').ChildProcess | null} */
  let child = null;
  let aborted = false;

  return {
    id: 'claude-code',
    label: 'Claude Code',

    async detect() {
      const bin = findClaudeBinary();
      if (!bin) {
        return { ok: false, reason: 'claude CLI를 찾을 수 없어요. Claude Code를 설치한 뒤 터미널에서 claude로 로그인해 주세요.' };
      }
      const v = await run(bin, ['--version'], 15000);
      if (v.code !== 0) return { ok: false, reason: `claude 실행에 실패했어요: ${(v.stderr || v.stdout).trim().slice(0, 200)}` };

      const a = await run(bin, ['auth', 'status'], 15000);
      try {
        if (JSON.parse(a.stdout).loggedIn === false) {
          return { ok: false, reason: 'claude에 로그인되어 있지 않아요. 터미널에서 claude를 실행해 로그인해 주세요.' };
        }
      } catch {
        // 상태를 해석할 수 없으면 일단 사용 가능으로 두고, 실제 요청에서 오류를 보여 준다.
      }
      return { ok: true };
    },

    send(msg) {
      const queue = createQueue();
      aborted = false;

      (async () => {
        const bin = findClaudeBinary();
        if (!bin) {
          queue.push({ type: 'error', message: 'claude CLI를 찾을 수 없어요.' });
          return queue.close();
        }
        // 파일 쓰기/명령 실행 도구는 모두 끈다. 권한 승인 UI(M4) 전까지는 대화만 한다.
        const args = [
          '-p',
          '--output-format', 'stream-json',
          '--verbose',
          '--include-partial-messages',
          '--tools', '',
          '--append-system-prompt-file', personaFile,
        ];
        if (sessionId) args.push('--resume', sessionId);

        /** @type {StreamState} */
        const st = { sawDelta: false, finished: false, status: null, sessionId: null };
        queue.push({ type: 'status', state: 'thinking' });
        st.status = 'thinking';

        const c = spawnCli(bin, args, { cwd: workDir, env: cleanEnv(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
        child = c;
        let stderr = '';
        let buf = '';

        c.stdout?.setEncoding('utf8').on('data', (chunk) => {
          buf += chunk;
          let i;
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            if (!line) continue;
            try {
              for (const ev of translateClaudeMessage(JSON.parse(line), st)) queue.push(ev);
            } catch {
              // JSON이 아닌 줄은 무시
            }
          }
        });
        c.stderr?.setEncoding('utf8').on('data', (d) => (stderr = (stderr + d).slice(-2000)));
        c.on('error', (e) => {
          st.finished = true;
          queue.push({ type: 'error', message: `claude 실행에 실패했어요: ${e.message}` });
          queue.close();
        });
        c.on('close', (code) => {
          if (st.sessionId && st.finished) sessionId = st.sessionId;
          if (!st.finished && !aborted) {
            queue.push(code === 0 ? { type: 'done' } : { type: 'error', message: stderr.trim().slice(-300) || `claude가 종료되었어요 (코드 ${code})` });
          }
          child = null;
          queue.close();
        });

        // 사용자 입력은 인자가 아니라 stdin으로만 전달한다 (인자 주입/길이 제한 방지).
        c.stdin?.on('error', () => {});
        c.stdin?.end(msg);
      })();

      return queue;
    },

    respondPermission() {
      // 도구를 끈 상태라 권한 요청이 발생하지 않는다. (M4에서 구현)
    },

    abort() {
      aborted = true;
      child?.kill();
    },

    reset() {
      sessionId = null;
    },
  };
}
