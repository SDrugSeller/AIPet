// @ts-check
// 설정 창과 안내 말풍선이 함께 쓰는 "설치하기 / 로그인하기" 진행 상태. 한 번에 한 가지 일만 한다. Electron에 의존하지 않는다.
//
// 로그인은 공식 CLI(`codex login`)가 직접 브라우저를 열어 처리한다. 앱은 그 명령을 대신 실행해 주기만 하고, 토큰은 보지도 저장하지도 않는다.
// (명령의 출력에서 로그인 주소 한 줄만 골라 보여 준다.)
import { cleanEnv, killTree, launchFailureMessage, spawnCli } from '../agent/cli.js';
import { createInstaller } from './installer.js';
import { getToolInfo, removeTools } from './toolManage.js';

/** 브라우저로 열어도 되는 로그인 주소인가 (공식 로그인 페이지만) @param {string} url */
export function isLoginUrl(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'https:' && /(^|\.)(openai\.com|chatgpt\.com)$/i.test(u.hostname);
  } catch {
    return false;
  }
}

/** 터미널 색 코드 (주소 뒤에 붙어 올 수 있어서 먼저 지운다) */
const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

/** 출력 한 줄에서 로그인 주소를 찾는다 (없으면 null) @param {string} line */
export function findLoginUrl(line) {
  const m = line.replace(ANSI, '').match(/https:\/\/[^\s"'<>]+/);
  return m && isLoginUrl(m[0]) ? m[0] : null;
}

/**
 * `<bin> login`을 실행한다. 끝날 때까지(또는 취소할 때까지) 기다린다.
 * @param {{ bin: string, signal?: AbortSignal, onUrl?: (url: string) => void, timeoutMs?: number }} p
 * @returns {Promise<{ code: number | null, error?: string, aborted?: boolean }>}
 */
export function runLogin({ bin, signal, onUrl = () => {}, timeoutMs = 10 * 60_000 }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnCli(bin, ['login'], { env: cleanEnv(), windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ code: null, error: String(/** @type {Error} */ (e).message) });
    }
    let done = false;
    let buf = '';
    const finish = (/** @type {{ code: number | null, error?: string, aborted?: boolean }} */ r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      resolve(r);
    };
    const onAbort = () => {
      killTree(child);
      finish({ code: null, aborted: true });
    };
    const timer = setTimeout(() => {
      killTree(child);
      finish({ code: null, error: '시간이 너무 오래 걸려서 멈췄어요' });
    }, timeoutMs);
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
    /** @param {string} chunk */
    const scan = (chunk) => {
      buf = (buf + chunk).slice(-4000);
      for (const line of buf.split(/\r?\n/)) {
        const url = findLoginUrl(line);
        if (url) onUrl(url);
      }
    };
    child.stdout?.setEncoding('utf8').on('data', scan);
    child.stderr?.setEncoding('utf8').on('data', scan);
    child.on('error', (e) => finish({ code: null, error: e.message }));
    child.on('close', (code) => finish({ code }));
  });
}

/**
 * @typedef {{
 *   install: { tool: string | null, phase: 'idle' | 'running' | 'done' | 'error', step: string, message: string, percent: number | null, reason: string },
 *   login: { connId: string | null, phase: 'idle' | 'running' | 'done' | 'error', url: string, message: string },
 * }} SetupState
 * @typedef {{ kind: 'install' | 'login', ok: boolean, cancelled?: boolean, tool?: string, connId?: string, message: string }} SetupResult
 */

/**
 * @param {{
 *   root: string,
 *   refresh: (connectionId?: string) => Promise<unknown>,
 *   findBin: (connectionId: string) => string | null,
 *   installer?: ReturnType<typeof createInstaller>,
 *   login?: typeof runLogin,
 *   openExternal?: (url: string) => void,
 *   beforeRefresh?: () => void | Promise<void>,
 *   onFinish?: (r: SetupResult) => void,
 * }} opts
 *   beforeRefresh: 설치가 끝난 뒤 연결을 다시 확인하기 전에 할 일 (예: 막힌 경로를 비워서 새로 설치한 것이 쓰이게 한다)
 */
export function createToolSetup({ root, refresh, findBin, installer = createInstaller({ root }), login = runLogin, openExternal = () => {}, beforeRefresh = () => {}, onFinish = () => {} }) {
  /** @type {SetupState} */
  let st = {
    install: { tool: null, phase: 'idle', step: '', message: '', percent: null, reason: '' },
    login: { connId: null, phase: 'idle', url: '', message: '' },
  };
  /** @type {Set<() => void>} */
  const listeners = new Set();
  /** @type {AbortController | null} */
  let installAbort = null;
  /** @type {AbortController | null} */
  let loginAbort = null;

  const emit = () => listeners.forEach((cb) => cb());
  /** @param {Partial<SetupState['install']>} patch */
  const setInstall = (patch) => {
    st = { ...st, install: { ...st.install, ...patch } };
    emit();
  };
  /** @param {Partial<SetupState['login']>} patch */
  const setLogin = (patch) => {
    st = { ...st, login: { ...st.login, ...patch } };
    emit();
  };

  return {
    state: () => structuredClone(st),
    /** 상태가 바뀔 때마다 부른다. 해제 함수를 돌려준다 @param {() => void} cb */
    subscribe(cb) {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    busy: () => st.install.phase === 'running' || st.login.phase === 'running',

    /** 설치를 시작한다. 이미 무언가 하는 중이면 false @param {string} tool @param {{ clean?: boolean }} [opts] clean: 이전 설치를 지우고 새로 설치 */
    startInstall(tool, { clean = false } = {}) {
      if (tool !== 'codex-cli' || st.install.phase === 'running' || st.login.phase === 'running') return false;
      const ac = (installAbort = new AbortController());
      setInstall({ tool, phase: 'running', step: 'prepare', message: '준비하는 중…', percent: null, reason: '' });
      void (async () => {
        const r = await installer.installCodex({
          signal: ac.signal,
          clean,
          onProgress: (p) => {
            if (installAbort === ac) setInstall({ step: p.step, message: p.message, percent: p.percent });
          },
        });
        if (installAbort === ac) installAbort = null;
        if (r.ok) {
          await beforeRefresh();
          await refresh(); // 설치 직후 연결을 다시 확인한다
          const message = `Codex ${r.version}을(를) 설치했어요`;
          setInstall({ phase: 'done', step: 'done', message, percent: 100, reason: '' });
          onFinish({ kind: 'install', ok: true, tool, message });
        } else {
          setInstall({ phase: 'error', step: r.step, message: '', percent: null, reason: r.reason });
          onFinish({ kind: 'install', ok: false, cancelled: r.cancelled, tool, message: r.reason });
        }
      })();
      return true;
    },

    cancelInstall() {
      installAbort?.abort();
    },

    /** 앱 전용 설치본의 상태 (버전, 위치, 용량) */
    info: () => getToolInfo(root),

    /**
     * 앱 전용 설치본을 지운다 ('codex' = Codex만, 'all' = 전용 Node.js까지). 다른 작업을 하는 중이면 지우지 않는다.
     * 지운 뒤 연결을 다시 확인한다.
     * @param {'codex' | 'all'} scope
     */
    async remove(scope) {
      if (st.install.phase === 'running' || st.login.phase === 'running') return { ok: false, reason: '설치나 로그인을 하는 중이에요. 끝난 뒤에 다시 시도해 주세요' };
      const r = removeTools(root, scope === 'all' ? 'all' : 'codex');
      if (r.ok) {
        st = { ...st, install: { tool: null, phase: 'idle', step: '', message: '', percent: null, reason: '' } };
        emit();
        await refresh();
      }
      return r;
    },

    /** 이 연결의 로그인을 시작한다 (브라우저가 열린다). 못 시작하면 사유를 돌려준다 @param {string} connId */
    startLogin(connId) {
      if (st.install.phase === 'running' || st.login.phase === 'running') return { ok: false, reason: '다른 작업을 하는 중이에요' };
      const bin = findBin(connId);
      if (!bin) return { ok: false, reason: 'codex를 찾지 못했어요. 먼저 설치해 주세요' };
      const ac = (loginAbort = new AbortController());
      setLogin({ connId, phase: 'running', url: '', message: '브라우저에서 로그인을 마쳐 주세요. 끝나면 자동으로 확인해요' });
      void (async () => {
        const r = await login({
          bin,
          signal: ac.signal,
          onUrl: (url) => {
            if (loginAbort !== ac || st.login.url === url) return;
            setLogin({ url });
          },
        });
        if (loginAbort === ac) loginAbort = null;
        if (r.aborted) {
          setLogin({ phase: 'idle', url: '', message: '로그인을 취소했어요' });
          onFinish({ kind: 'login', ok: false, cancelled: true, connId, message: '로그인을 취소했어요' });
          return;
        }
        await refresh(connId);
        if (r.code === 0) {
          setLogin({ phase: 'done', url: '', message: '로그인했어요' });
          onFinish({ kind: 'login', ok: true, connId, message: '로그인했어요' });
        } else {
          const message = r.error ? launchFailureMessage('codex', r.error, { bin }) : `로그인이 끝나지 않았어요 (코드 ${r.code}). 다시 시도해 주세요`;
          setLogin({ phase: 'error', url: '', message });
          onFinish({ kind: 'login', ok: false, connId, message });
        }
      })();
      return { ok: true };
    },

    cancelLogin() {
      loginAbort?.abort();
    },

    /** 로그인 주소를 기본 브라우저로 연다 (공식 로그인 주소만) @param {string} url */
    openLoginUrl(url) {
      if (isLoginUrl(url)) openExternal(url);
    },
  };
}
