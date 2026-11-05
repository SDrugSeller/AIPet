// @ts-check
// Claude Code CLI 어댑터. 사용자가 직접 로그인한 공식 `claude` CLI를 서브프로세스로 실행하고
// `--output-format stream-json` 출력을 AgentEvent로 변환한다. 앱은 토큰을 보지 않는다. (DESIGN.md 4.2/4.3)
//
// 권한 요청: `--input-format stream-json --permission-prompt-tool stdio`로 실행하면 CLI가 도구를 쓰기 전에
// stdout으로 control_request(can_use_tool)를 보내고, 우리가 stdin으로 control_response(allow/deny)를 돌려준다.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createQueue, PERSONA, PERSONA_TOOLS } from './adapter.js';

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
 * `claude` 실행 파일을 찾는다. 순서: 직접 지정한 경로 → PATH → 공식 설치 위치 → VS Code 확장에 포함된 바이너리.
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [override]  설정에서 직접 지정한 경로. 지정했는데 없으면 null (다른 곳을 뒤지지 않는다)
 * @returns {string | null}
 */
export function findClaudeBinary(env = process.env, override = '') {
  if (override) return isFile(override) ? override : null;

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
 * @typedef {{
 *   sawDelta: boolean, finished: boolean, status: string | null, sessionId: string | null,
 *   requests?: Map<string, any>,
 * }} StreamState
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
    case 'control_request': {
      const r = msg.request;
      if (r?.subtype === 'can_use_tool' && typeof msg.request_id === 'string') {
        // 허용 응답에 원래 입력을 그대로 돌려줘야 하므로 기억해 둔다.
        (st.requests ??= new Map()).set(msg.request_id, r.input ?? {});
        out.push({ type: 'tool_request', id: msg.request_id, name: String(r.tool_name ?? ''), input: r.input ?? {} });
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
 * @param {{
 *   getConfig: () => { path: string, tools: boolean, workDir: string },
 *   metaDir: string,
 * }} opts
 *   workDir: 에이전트가 접근하는 작업 폴더. CLI는 항상 여기서 실행된다.
 *   metaDir: 페르소나 파일 등 에이전트가 건드리면 안 되는 파일을 두는 폴더.
 * @returns {import('./adapter.js').AgentAdapter}
 */
export function createClaudeCodeAdapter({ getConfig, metaDir }) {
  /** @type {string | null} 이어서 대화하기 위한 세션 ID */
  let sessionId = null;
  /** 세션 ID가 만들어진 작업 폴더 (바뀌면 이어 말할 수 없다) */
  let sessionCwd = '';
  /** @type {import('node:child_process').ChildProcess | null} */
  let child = null;
  /** @type {StreamState | null} */
  let current = null;
  let aborted = false;

  /** @param {unknown} obj */
  const writeLine = (obj) => {
    if (child?.stdin && !child.stdin.destroyed) child.stdin.write(`${JSON.stringify(obj)}\n`);
  };

  return {
    id: 'claude-code',
    label: 'Claude Code',

    async detect() {
      const bin = findClaudeBinary(process.env, getConfig().path);
      if (!bin) {
        return {
          ok: false,
          reason: getConfig().path
            ? '지정한 경로에서 claude를 찾을 수 없어요. 설정에서 경로를 확인해 주세요.'
            : 'claude CLI를 찾을 수 없어요. Claude Code를 설치한 뒤 터미널에서 claude로 로그인해 주세요.',
        };
      }
      const v = await run(bin, ['--version'], 15000);
      if (v.code !== 0) return { ok: false, reason: `claude 실행에 실패했어요: ${(v.stderr || v.stdout).trim().slice(0, 200)}` };

      const a = await run(bin, ['auth', 'status'], 15000);
      let info = `${v.stdout.trim()} · ${bin}`;
      try {
        const s = JSON.parse(a.stdout);
        if (s.loggedIn === false) {
          return { ok: false, reason: 'claude에 로그인되어 있지 않아요. 터미널에서 claude를 실행해 로그인해 주세요.' };
        }
        const who = [s.authMethod, s.email, s.orgName].filter((x) => typeof x === 'string' && x).join(' · ');
        info = `로그인: ${who || '확인됨'}\n${v.stdout.trim()} · ${bin}`;
      } catch {
        // 상태를 해석할 수 없으면 일단 사용 가능으로 두고, 실제 요청에서 오류를 보여 준다.
      }
      return { ok: true, info };
    },

    send(msg) {
      const queue = createQueue();
      aborted = false;

      (async () => {
        const cfg = getConfig();
        const bin = findClaudeBinary(process.env, cfg.path);
        if (!bin) {
          queue.push({ type: 'error', message: 'claude CLI를 찾을 수 없어요.' });
          return queue.close();
        }
        fs.mkdirSync(cfg.workDir, { recursive: true });
        fs.mkdirSync(metaDir, { recursive: true });
        const personaFile = path.join(metaDir, cfg.tools ? 'persona-tools.txt' : 'persona.txt');
        fs.writeFileSync(personaFile, cfg.tools ? PERSONA_TOOLS : PERSONA, 'utf8');

        const args = [
          '-p',
          '--input-format', 'stream-json',
          '--output-format', 'stream-json',
          '--verbose',
          '--include-partial-messages',
          '--permission-prompt-tool', 'stdio', // 권한 질문을 stdout/stdin으로 우리에게 넘긴다
          // 사용자 전역 설정(허용 규칙, 훅 등)이 우리의 승인 절차를 우회하지 못하게 한다.
          '--setting-sources', 'project,local',
          '--append-system-prompt-file', personaFile,
        ];
        if (!cfg.tools) args.push('--tools', ''); // 도구를 모두 끈 대화 전용 모드
        if (sessionId && sessionCwd === cfg.workDir) args.push('--resume', sessionId);

        /** @type {StreamState} */
        const st = { sawDelta: false, finished: false, status: null, sessionId: null };
        current = st;
        queue.push({ type: 'status', state: 'thinking' });
        st.status = 'thinking';

        const c = spawnCli(bin, args, { cwd: cfg.workDir, env: cleanEnv(), windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
        child = c;
        let stderr = '';
        let buf = '';

        /** @param {string} line */
        const onLine = (line) => {
          let m;
          try {
            m = JSON.parse(line);
          } catch {
            return; // JSON이 아닌 줄은 무시
          }
          // 우리가 처리하지 않는 종류의 요청에는 오류로 답해 CLI가 기다리지 않게 한다.
          if (m?.type === 'control_request' && m.request?.subtype !== 'can_use_tool') {
            writeLine({ type: 'control_response', response: { subtype: 'error', request_id: m.request_id, error: '지원하지 않는 요청이에요' } });
            return;
          }
          for (const ev of translateClaudeMessage(m, st)) queue.push(ev);
          if (st.finished) c.stdin?.end(); // 한 번의 대화가 끝나면 CLI가 종료되도록 입력을 닫는다
        };

        c.stdout?.setEncoding('utf8').on('data', (chunk) => {
          buf += chunk;
          let i;
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            if (line) onLine(line);
          }
        });
        c.stderr?.setEncoding('utf8').on('data', (d) => (stderr = (stderr + d).slice(-2000)));
        c.on('error', (e) => {
          st.finished = true;
          queue.push({ type: 'error', message: `claude 실행에 실패했어요: ${e.message}` });
          queue.close();
        });
        c.on('close', (code) => {
          if (st.sessionId && st.finished) {
            sessionId = st.sessionId;
            sessionCwd = cfg.workDir;
          }
          if (!st.finished && !aborted) {
            queue.push(code === 0 ? { type: 'done' } : { type: 'error', message: stderr.trim().slice(-300) || `claude가 종료되었어요 (코드 ${code})` });
          }
          child = null;
          current = null;
          queue.close();
        });

        // 사용자 입력은 인자가 아니라 stdin(JSON 한 줄)으로만 전달한다 (인자 주입/길이 제한 방지).
        c.stdin?.on('error', () => {});
        writeLine({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: msg }] } });
      })();

      return queue;
    },

    respondPermission(id, allow, message) {
      const input = current?.requests?.get(id);
      if (input === undefined) return;
      current?.requests?.delete(id);
      writeLine({
        type: 'control_response',
        response: {
          subtype: 'success',
          request_id: id,
          response: allow ? { behavior: 'allow', updatedInput: input } : { behavior: 'deny', message: message || '사용자가 거부했어요' },
        },
      });
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
