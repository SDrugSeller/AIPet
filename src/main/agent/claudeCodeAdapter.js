// @ts-check
// Claude Code CLI 어댑터. 사용자가 직접 로그인한 공식 `claude` CLI를 서브프로세스로 실행하고
// `--output-format stream-json` 출력을 AgentEvent로 변환한다. 앱은 토큰을 보지 않는다. (DESIGN.md 4.2/4.3)
//
// 권한 요청: `--input-format stream-json --permission-prompt-tool stdio`로 실행하면 CLI가 도구를 쓰기 전에
// stdout으로 control_request(can_use_tool)를 보내고, 우리가 stdin으로 control_response(allow/deny)를 돌려준다.
//
// 여러 계정: CLI는 설정 폴더(CLAUDE_CONFIG_DIR)마다 로그인 상태를 따로 가진다.
// 연결마다 configDir을 다르게 주면 계정이 분리된다. (각 폴더에서 한 번씩 로그인해 둬야 한다)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { buildSystemPrompt, createQueue } from './adapter.js';
import { cleanEnv, findOnPath, isFile, isWin, killTree, readLines, run, spawnCli } from './cli.js';

const exe = isWin ? '.exe' : '';

/**
 * `claude` 실행 파일을 찾는다. 순서: 직접 지정한 경로 → PATH → 공식 설치 위치 → VS Code 확장에 포함된 바이너리.
 * @param {NodeJS.ProcessEnv} [env]
 * @param {string} [override]  설정에서 직접 지정한 경로. 지정했는데 없으면 null (다른 곳을 뒤지지 않는다)
 * @returns {string | null}
 */
export function findClaudeBinary(env = process.env, override = '') {
  if (override) return isFile(override) ? override : null;

  const onPath = findOnPath('claude', env);
  if (onPath) return onPath;

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

/** --resume한 세션을 CLI가 찾지 못할 때의 메시지 ("No conversation found with session ID: ...") */
const NO_SESSION = /no conversation found/i;
/** 로그인이 없거나 풀렸을 때 CLI가 내는 메시지 ("Not logged in · Please run /login" 등) */
const LOGGED_OUT = /not logged in|please run \/login|invalid (api key|authentication)|oauth token.*(expired|revoked)/i;

/**
 * stream-json 한 줄(JSON 객체)을 AgentEvent 목록으로 바꾼다. 상태(st)는 한 번의 send 동안 유지된다.
 * @typedef {{
 *   sawDelta: boolean, finished: boolean, status: string | null, sessionId: string | null,
 *   requests?: Map<string, any>,
 *   resumed?: boolean, sessionLost?: boolean, failed?: boolean, apiError?: string, syntheticText?: string,
 * }} StreamState
 *   resumed: 이어서 말하려고 --resume을 붙였다 / sessionLost: 이어 말하려던 세션을 CLI가 찾지 못했다
 *   failed: 이번 대화가 오류로 끝났다 / apiError, syntheticText: CLI가 직접 만든 오류 안내(로그인 풀림 등)
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
      // 로그인이 풀리는 등 API 오류가 나면 CLI가 모델 대신 안내 문장을 "답변"으로 만들어 보내고(model '<synthetic>'),
      // 같은 문장을 결과(result)에도 또 실어 보낸다. 답변으로 두 번 보이지 않게 따로 보관했다가 결과에서 한 번만 쓴다.
      if (msg.message?.model === '<synthetic>' && typeof msg.error === 'string') {
        st.apiError = msg.error;
        st.syntheticText = (msg.message.content ?? []).map((/** @type {any} */ b) => (b?.type === 'text' ? b.text : '')).join('');
        break;
      }
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
      if (!msg.is_error) {
        if (st.syntheticText) out.push({ type: 'text', delta: st.syntheticText }); // 오류가 아닌데 CLI가 보낸 안내는 그대로 보여 준다
        out.push({ type: 'done' });
        break;
      }
      st.failed = true;
      const errors = Array.isArray(msg.errors) ? msg.errors.map(String).join('\n') : '';
      const raw = String(msg.result || errors || st.syntheticText || msg.subtype || '알 수 없는 오류');
      // 이어 말하려던 세션이 사라졌다(오래돼서 정리됐거나 폴더를 지움). 어댑터가 새 대화로 다시 시도한다.
      if (st.resumed && NO_SESSION.test(raw)) {
        st.sessionLost = true;
        break;
      }
      if (st.apiError === 'authentication_failed' || LOGGED_OUT.test(raw)) {
        out.push({ type: 'session', text: '로그인 세션이 만료됐어요' });
        out.push({ type: 'error', message: `Claude Code 로그인이 풀렸어요. 터미널에서 claude를 실행해 /login으로 다시 로그인한 뒤 이어서 말해 주세요. (${raw})` });
        break;
      }
      out.push({ type: 'error', message: raw });
      break;
    }
  }
  return out;
}

/**
 * @param {{
 *   getConfig: () => { path: string, configDir?: string, tools: boolean, workDir: string, persona?: string },
 *   metaDir: string,
 * }} opts
 *   workDir: 에이전트가 접근하는 작업 폴더. CLI는 항상 여기서 실행된다.
 *   metaDir: 페르소나 파일 등 에이전트가 건드리면 안 되는 파일을 두는 폴더. 연결마다 따로 쓴다.
 * @returns {import('./adapter.js').AgentAdapter}
 */
export function createClaudeCodeAdapter({ getConfig, metaDir }) {
  /** @type {string | null} 이어서 대화하기 위한 세션 ID */
  let sessionId = null;
  /**
   * 세션이 만들어졌을 때의 작업 폴더/계정/시스템 프롬프트. CLI는 처음 보낸 시스템 프롬프트를 세션에 기록해 두고
   * 이어 말할 때 그대로 다시 쓰므로, 이 값이 바뀌면(말투/도구/폴더/계정 변경) 새 세션으로 시작해야 한다.
   */
  let sessionKey = '';
  /** @type {import('node:child_process').ChildProcess | null} */
  let child = null;
  /** @type {StreamState | null} */
  let current = null;
  let aborted = false;

  /** 계정을 분리하려면 연결마다 다른 설정 폴더를 CLI에 알려 준다. @param {{ configDir?: string }} cfg */
  const envFor = (cfg) => (cfg.configDir ? { CLAUDE_CONFIG_DIR: cfg.configDir } : {});

  /** @param {unknown} obj */
  const writeLine = (obj) => {
    if (child?.stdin && !child.stdin.destroyed) child.stdin.write(`${JSON.stringify(obj)}\n`);
  };

  return {
    id: 'claude-code',
    label: 'Claude Code',

    async detect() {
      const cfg = getConfig();
      const bin = findClaudeBinary(process.env, cfg.path);
      if (!bin) {
        return {
          ok: false,
          reason: cfg.path
            ? '지정한 경로에서 claude를 찾을 수 없어요. 설정에서 경로를 확인해 주세요.'
            : 'claude CLI를 찾을 수 없어요. Claude Code를 설치한 뒤 터미널에서 claude로 로그인해 주세요.',
        };
      }
      const env = envFor(cfg);
      const v = await run(bin, ['--version'], 15000, env);
      if (v.code !== 0) return { ok: false, reason: `claude 실행에 실패했어요: ${(v.stderr || v.stdout).trim().slice(0, 200)}` };

      const a = await run(bin, ['auth', 'status'], 15000, env);
      let info = `${v.stdout.trim()} · ${bin}`;
      try {
        const s = JSON.parse(a.stdout);
        if (s.loggedIn === false) {
          return {
            ok: false,
            reason: cfg.configDir
              ? `이 설정 폴더(${cfg.configDir})에는 로그인된 계정이 없어요. 아래 "로그인 명령 복사"로 터미널에서 로그인해 주세요.`
              : 'claude에 로그인되어 있지 않아요. 터미널에서 claude를 실행해 로그인해 주세요.',
          };
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
        const systemPrompt = buildSystemPrompt(cfg.persona, cfg.tools);
        const key = JSON.stringify([cfg.workDir, cfg.configDir ?? '', cfg.tools, systemPrompt]);
        const personaFile = path.join(metaDir, 'system-prompt.txt');
        fs.writeFileSync(personaFile, systemPrompt, 'utf8');

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

        // 이어 말할 세션이 있어도 말투/도구/폴더/계정이 바뀌었으면 이을 수 없다. 조용히 새 대화가 되지 않게 표시를 남긴다.
        if (sessionId && sessionKey !== key) {
          queue.push({ type: 'session', text: '설정이 바뀌어서 이전 대화를 이어가지 못해요. 새 대화로 시작해요' });
          sessionId = null;
        }

        /**
         * CLI를 한 번 실행한다. resume=true인데 CLI가 그 세션을 찾지 못하면(만료/삭제) 새 대화로 한 번 다시 시도한다.
         * @param {boolean} resume
         */
        const launch = (resume) => {
          /** @type {StreamState} */
          const st = { sawDelta: false, finished: false, status: null, sessionId: null, resumed: resume };
          current = st;
          queue.push({ type: 'status', state: 'thinking' });
          st.status = 'thinking';

          const c = spawnCli(bin, resume && sessionId ? [...args, '--resume', sessionId] : args, {
            cwd: cfg.workDir,
            env: cleanEnv(envFor(cfg)),
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe'],
          });
          child = c;
          let stderr = '';

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

          readLines(c.stdout, onLine);
          c.stderr?.setEncoding('utf8').on('data', (d) => (stderr = (stderr + d).slice(-2000)));
          c.on('error', (e) => {
            st.finished = true;
            queue.push({ type: 'error', message: `claude 실행에 실패했어요: ${e.message}` });
            queue.close();
          });
          c.on('close', (code) => {
            // 오류로 끝난 대화의 세션은 이어 쓰지 않는다 (없는 세션을 계속 붙잡아 이후 대화가 모두 실패하는 것을 막는다).
            if (st.sessionId && st.finished && !st.failed) {
              sessionId = st.sessionId;
              sessionKey = key;
            }
            child = null;
            current = null;
            if (st.sessionLost && !aborted) {
              sessionId = null;
              queue.push({ type: 'session', text: '이전 대화 세션이 만료됐어요. 새 대화로 이어가요 (앞선 내용은 기억하지 못해요)' });
              launch(false);
              return;
            }
            if (!st.finished && !aborted) {
              queue.push(code === 0 ? { type: 'done' } : { type: 'error', message: stderr.trim().slice(-300) || `claude가 종료되었어요 (코드 ${code})` });
            }
            queue.close();
          });

          // 사용자 입력은 인자가 아니라 stdin(JSON 한 줄)으로만 전달한다 (인자 주입/길이 제한 방지).
          c.stdin?.on('error', () => {});
          writeLine({ type: 'user', message: { role: 'user', content: [{ type: 'text', text: msg }] } });
        };

        launch(!!sessionId);
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
      killTree(child);
    },

    reset() {
      sessionId = null;
    },
  };
}
