// @ts-check
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import path from 'node:path';
import { KIND_IDS, MAX_CONNECTIONS, keySecretName, newConnection } from '../shared/connections.js';
import { findClaudeBinary } from './agent/claudeCodeAdapter.js';
import { findCodexBinary, STORE_CODEX_EXE } from './agent/codexCliAdapter.js';
import { findGeminiBinary } from './agent/geminiCliAdapter.js';
import { DEFAULT_OPENAI_BASE_URL } from './config.js';
import { inspectSkin, listSkins, userSkinsDir } from './skin.js';
import { claudeCandidates, codexCandidates, diagnose, geminiCandidates } from './tools/diagnose.js';

/**
 * 설정 창 (일반 창). 렌더러는 별도 preload로 필요한 API만 쓰고, 비밀(API 키)은 값을 받지 못한다.
 * @param {{
 *   store: ReturnType<typeof import('./store.js').createStore>,
 *   config: ReturnType<typeof import('./config.js').createConfig>,
 *   personas: ReturnType<typeof import('./personas.js').createPersonaStore>,
 *   manager: ReturnType<typeof import('./windows.js').createOverlayManager>,
 *   tools: ReturnType<typeof import('./tools/toolSetup.js').createToolSetup>,
 *   userDataDir: string,
 *   preloadPath: string,
 *   htmlPath: string,
 *   packaged: boolean,
 * }} opts
 */
export function createSettingsWindow({ store, config, personas, manager, tools, userDataDir, preloadPath, htmlPath, packaged }) {
  /** @type {BrowserWindow | null} */
  let win = null;
  /** 열 때 먼저 보여 줄 탭 */
  let initialTab = '';

  /** 설치된 스킨 목록 (설정 창을 열 때 읽는다) */
  /** @type {{ id: string, name: string, author: string, source: 'bundled' | 'user' }[]} */
  let skins = [];

  function state() {
    const s = store.get();
    return {
      settings: s,
      statuses: manager.statuses(),
      /** 연결별로 저장된 API 키가 있는가 (키 값 자체는 렌더러로 보내지 않는다) */
      hasKey: Object.fromEntries(s.connections.map((c) => [c.id, store.hasSecret(keySecretName(c.id))])),
      personas: { dir: personas.dir, items: personas.list() },
      skins,
      skinsDir: userSkinsDir(),
      defaults: {
        workDir: config.defaultWorkDir,
        accountDir: path.join(userDataDir, 'claude-accounts'),
        openaiBaseUrl: DEFAULT_OPENAI_BASE_URL,
        toolsDir: path.join(userDataDir, 'tools'),
      },
      keyFromEnv: { openai: !!process.env.AIPET_OPENAI_KEY, anthropic: !!(process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) },
      packaged,
      /** 앱이 대신 하는 설치/로그인의 진행 상태 */
      tools: tools.state(),
    };
  }

  function pushState() {
    if (win && !win.isDestroyed()) win.webContents.send('settings:state', state());
  }

  /** 이 창에서 온 요청만 받는다. @param {Electron.IpcMainInvokeEvent} e */
  const fromSettings = (e) => !!win && !win.isDestroyed() && e.sender === win.webContents;

  ipcMain.handle('settings:get', (e) => (fromSettings(e) ? { ...state(), initialTab } : null));

  ipcMain.handle('settings:set', (e, patch) => {
    if (!fromSettings(e)) return null;
    store.update(patch);
    return state();
  });

  // --- 연결 추가/삭제/점검 ---

  ipcMain.handle('settings:add', (e, kind) => {
    if (!fromSettings(e) || typeof kind !== 'string' || !KIND_IDS.includes(/** @type {any} */ (kind))) return null;
    const existing = store.get().connections;
    if (existing.length >= MAX_CONNECTIONS) return { error: `연결은 최대 ${MAX_CONNECTIONS}개까지 만들 수 있어요`, state: state() };
    const persona = personas.list()[0]?.id ?? '기본.txt';
    store.update({ connections: [...existing, newConnection(/** @type {any} */ (kind), existing, { persona })] });
    return { state: state() };
  });

  ipcMain.handle('settings:remove', (e, id) => {
    if (!fromSettings(e) || typeof id !== 'string') return null;
    store.update({ connections: store.get().connections.filter((c) => c.id !== id) }); // 그 연결의 API 키도 함께 지워진다
    return state();
  });

  ipcMain.handle('settings:recheck', async (e, id) => {
    if (!fromSettings(e)) return null;
    if (typeof id === 'string') await manager.refresh(id);
    else await manager.refreshAll();
    return state();
  });

  ipcMain.handle('settings:secret', async (e, id, value) => {
    if (!fromSettings(e) || typeof id !== 'string' || (value !== null && typeof value !== 'string')) return null;
    const result = store.setSecret(keySecretName(id), value);
    await manager.refresh(id);
    return { result, state: state() };
  });

  /** Claude Code 계정을 따로 로그인하는 터미널 명령 (복사해서 붙여 넣는다). 사용자 입력은 따옴표를 이스케이프해서 넣는다. */
  ipcMain.handle('settings:login-command', (e, id) => {
    if (!fromSettings(e) || typeof id !== 'string') return null;
    const c = store.get().connections.find((x) => x.id === id);
    if (!c || c.kind !== 'claude-code') return null;
    const cfg = config.claude(id);
    if (!cfg.configDir) return { ok: false, reason: '먼저 "계정 설정 폴더"를 정해 주세요' };
    const q = (/** @type {string} */ s) => `'${s.replace(/'/g, "''")}'`;
    const bin = findClaudeBinary(process.env, cfg.path) ?? 'claude';
    return { ok: true, command: `$env:CLAUDE_CONFIG_DIR=${q(cfg.configDir)}; & ${q(bin)}` };
  });

  // --- 설치하기 / 로그인하기 (Codex) ---

  ipcMain.handle('settings:tools-install', (e, tool) => {
    if (!fromSettings(e) || typeof tool !== 'string') return null;
    return { started: tools.startInstall(tool), state: state() };
  });

  ipcMain.handle('settings:tools-cancel', (e) => {
    if (!fromSettings(e)) return null;
    tools.cancelInstall();
    return true;
  });

  ipcMain.handle('settings:tools-login', (e, id) => {
    if (!fromSettings(e) || typeof id !== 'string') return null;
    const c = store.get().connections.find((x) => x.id === id);
    if (!c || c.kind !== 'codex-cli') return null;
    return { ...tools.startLogin(id), state: state() };
  });

  ipcMain.handle('settings:tools-cancel-login', (e) => {
    if (!fromSettings(e)) return null;
    tools.cancelLogin();
    return true;
  });

  /** 로그인 주소를 다시 열기 (공식 로그인 주소만 연다) */
  ipcMain.handle('settings:tools-open-login-url', (e, url) => {
    if (!fromSettings(e) || typeof url !== 'string') return null;
    tools.openLoginUrl(url);
    return true;
  });

  // --- 원인 진단 / 도구 설치 탭 ---

  /** 연결 하나를 진단한다: 후보 실행 파일을 실제로 실행해 보고, 로그인·폴더·인터넷을 확인해 결론을 돌려준다 */
  ipcMain.handle('settings:diagnose', async (e, id) => {
    if (!fromSettings(e) || typeof id !== 'string') return null;
    const c = store.get().connections.find((x) => x.id === id);
    if (!c) return null;
    const toolsRoot = path.join(userDataDir, 'tools');
    const base = { toolsRoot, appVersion: app.getVersion() };
    try {
      if (c.kind === 'codex-cli') {
        const cfg = config.codex(id);
        return await diagnose({
          ...base,
          tool: 'Codex',
          candidates: codexCandidates({ configPath: cfg.path, toolsRoot, storeExe: STORE_CODEX_EXE }),
          currentBin: findCodexBinary(cfg.path),
          loginArgs: ['login', 'status'],
          netTargets: [
            { name: 'Node.js 내려받기(nodejs.org)', url: 'https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt' },
            { name: 'npm 레지스트리', url: 'https://registry.npmjs.org/@openai/codex/latest' },
          ],
          installable: true,
          hasCustomPath: !!cfg.path,
          workDir: cfg.workDir,
        });
      }
      if (c.kind === 'claude-code') {
        const cfg = config.claude(id);
        return await diagnose({
          ...base,
          tool: 'Claude Code',
          candidates: claudeCandidates({ configPath: cfg.path }),
          currentBin: findClaudeBinary(process.env, cfg.path),
          loginArgs: ['auth', 'status'],
          netTargets: [{ name: 'Anthropic(api.anthropic.com)', url: 'https://api.anthropic.com' }],
          hasCustomPath: !!cfg.path,
          workDir: cfg.workDir,
        });
      }
      if (c.kind === 'gemini-cli') {
        const cfg = config.gemini(id);
        return await diagnose({
          ...base,
          tool: 'Gemini CLI',
          candidates: geminiCandidates({ configPath: cfg.path }),
          currentBin: findGeminiBinary(cfg.path),
          netTargets: [{ name: 'Google AI(generativelanguage.googleapis.com)', url: 'https://generativelanguage.googleapis.com' }],
          hasCustomPath: !!cfg.path,
          workDir: cfg.workDir,
        });
      }
    } catch (err) {
      return { tool: c.kind, level: 'bad', headline: '진단 중에 문제가 생겼어요.', advice: String(/** @type {Error} */ (err).message ?? err), recommend: null, candidates: [], login: null, net: [], notes: [], text: `진단 실패: ${String(/** @type {Error} */ (err).message ?? err)}` };
    }
    return null; // API 연결은 외부 프로그램이 없어서 진단할 것이 없다
  });

  ipcMain.handle('settings:tools-info', async (e) => {
    if (!fromSettings(e)) return null;
    return tools.info();
  });

  /** "새로 설치": 이전에 앱이 설치한 Codex를 지우고 다시 설치한다 */
  ipcMain.handle('settings:tools-reinstall', (e, tool) => {
    if (!fromSettings(e) || typeof tool !== 'string') return null;
    return { started: tools.startInstall(tool, { clean: true }), state: state() };
  });

  ipcMain.handle('settings:tools-remove', async (e, scope) => {
    if (!fromSettings(e) || (scope !== 'codex' && scope !== 'all')) return null;
    const r = await tools.remove(scope);
    return { result: r, state: state() };
  });

  ipcMain.handle('settings:pick-dir', async (e) => {
    if (!fromSettings(e) || !win) return null;
    const r = await dialog.showOpenDialog(win, { title: '폴더 선택', properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });

  // --- 말투 파일 ---

  ipcMain.handle('settings:persona-read', (e, id) => {
    if (!fromSettings(e) || typeof id !== 'string') return null;
    return personas.read(id);
  });

  ipcMain.handle('settings:persona-save', (e, id, text) => {
    if (!fromSettings(e) || typeof id !== 'string' || typeof text !== 'string') return null;
    personas.write(id, text);
    return true;
  });

  ipcMain.handle('settings:persona-create', (e, name, text) => {
    if (!fromSettings(e) || typeof name !== 'string' || typeof text !== 'string') return null;
    const result = personas.create(name, text);
    return { result, state: state() };
  });

  ipcMain.handle('settings:persona-delete', (e, id) => {
    if (!fromSettings(e) || typeof id !== 'string') return null;
    const items = personas.list();
    if (items.length <= 1) return { result: { ok: false, reason: '마지막 말투는 지울 수 없어요' }, state: state() };
    const result = personas.remove(id);
    if (result.ok) {
      // 이 말투를 쓰던 연결은 남은 첫 번째 말투로 옮긴다
      const first = personas.list()[0]?.id;
      if (first) store.update({ connections: store.get().connections.map((c) => (c.persona === id ? { ...c, persona: first } : c)) });
    }
    return { result, state: state() };
  });

  ipcMain.handle('settings:persona-open-folder', async (e) => {
    if (!fromSettings(e)) return null;
    await shell.openPath(personas.dir);
    return true;
  });

  // --- 스킨 추가 (사용자 스킨 폴더) ---

  ipcMain.handle('settings:skins-open-folder', async (e) => {
    if (!fromSettings(e)) return null;
    const dir = userSkinsDir();
    if (!dir) return false;
    await shell.openPath(dir);
    return true;
  });

  /** 폴더에 새로 넣은 스킨을 목록에 반영한다 */
  ipcMain.handle('settings:skins-refresh', async (e) => {
    if (!fromSettings(e)) return null;
    skins = await listSkins();
    return state();
  });

  // --- 스킨 크기 ---

  ipcMain.handle('settings:skin-info', async (e, id) => {
    if (!fromSettings(e) || typeof id !== 'string') return null;
    const info = await inspectSkin(id);
    return info ? { ...info, current: store.get().skinTuning[id] ?? null } : null;
  });

  return {
    /** @param {string} [tab] 먼저 보여 줄 탭 */
    open(tab) {
      initialTab = tab ?? '';
      if (win && !win.isDestroyed()) {
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
        if (tab) win.webContents.send('settings:tab', tab);
        return;
      }
      win = new BrowserWindow({
        width: 640,
        height: 780,
        minWidth: 480,
        minHeight: 480,
        title: 'AIPet 설정',
        autoHideMenuBar: true,
        show: false,
        webPreferences: {
          preload: preloadPath,
          contextIsolation: true,
          nodeIntegration: false,
          sandbox: true,
        },
      });
      win.setMenuBarVisibility(false);
      win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
      win.webContents.on('will-navigate', (e) => e.preventDefault());
      win.once('ready-to-show', () => win?.show());
      win.on('closed', () => (win = null));
      void win.loadFile(htmlPath);
      void listSkins().then((list) => {
        skins = list;
        pushState();
      });
      void manager.refreshAll(); // 열 때마다 최신 상태로 (끝나면 onStatus로 화면이 갱신된다)
    },
    pushState,
    /** 디버그/검증용 */
    getWindow: () => win,
  };
}

