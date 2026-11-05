// @ts-check
import { BrowserWindow, dialog, ipcMain } from 'electron';
import { DEFAULT_OPENAI_BASE_URL } from './config.js';

/**
 * 설정 창 (일반 창). 렌더러는 별도 preload로 필요한 API만 쓰고, 비밀(API 키)은 값을 받지 못한다.
 * @param {{
 *   store: ReturnType<typeof import('./store.js').createStore>,
 *   config: ReturnType<typeof import('./config.js').createConfig>,
 *   host: ReturnType<typeof import('./agent/agentHost.js').createAgentHost>,
 *   preloadPath: string,
 *   htmlPath: string,
 *   packaged: boolean,
 * }} opts
 */
export function createSettingsWindow({ store, config, host, preloadPath, htmlPath, packaged }) {
  /** @type {BrowserWindow | null} */
  let win = null;

  function state() {
    return {
      settings: store.get(),
      hasKey: { openaiKey: store.hasSecret('openaiKey') },
      backends: host.backends(),
      defaults: { workDir: config.defaultWorkDir, openaiBaseUrl: DEFAULT_OPENAI_BASE_URL },
      keyFromEnv: !!process.env.AIPET_OPENAI_KEY,
      packaged,
    };
  }

  function pushState() {
    if (win && !win.isDestroyed()) win.webContents.send('settings:state', state());
  }

  /** 이 창에서 온 요청만 받는다. @param {Electron.IpcMainInvokeEvent} e */
  const fromSettings = (e) => !!win && !win.isDestroyed() && e.sender === win.webContents;

  ipcMain.handle('settings:get', (e) => (fromSettings(e) ? state() : null));

  ipcMain.handle('settings:set', async (e, patch) => {
    if (!fromSettings(e)) return null;
    store.update(patch);
    // AI 연결 관련 설정이 바뀌면 새 설정으로 다시 점검한다.
    if (patch && typeof patch === 'object' && 'adapters' in patch) await host.refresh();
    return state();
  });

  ipcMain.handle('settings:secret', async (e, name, value) => {
    if (!fromSettings(e) || typeof name !== 'string' || (value !== null && typeof value !== 'string')) return null;
    const result = store.setSecret(name, value);
    await host.refresh();
    return { result, state: state() };
  });

  ipcMain.handle('settings:select', (e, id) => {
    if (!fromSettings(e) || typeof id !== 'string') return null;
    host.select(id);
    return state();
  });

  ipcMain.handle('settings:recheck', async (e) => {
    if (!fromSettings(e)) return null;
    await host.refresh();
    return state();
  });

  ipcMain.handle('settings:pick-dir', async (e) => {
    if (!fromSettings(e) || !win) return null;
    const r = await dialog.showOpenDialog(win, { title: '작업 폴더 선택', properties: ['openDirectory', 'createDirectory'] });
    return r.canceled ? null : (r.filePaths[0] ?? null);
  });

  return {
    open() {
      if (win && !win.isDestroyed()) {
        if (win.isMinimized()) win.restore();
        win.show();
        win.focus();
        return;
      }
      win = new BrowserWindow({
        width: 580,
        height: 760,
        minWidth: 460,
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
      void host.refresh().then(pushState); // 열 때마다 최신 상태로
    },
    pushState,
    /** 디버그/검증용 */
    getWindow: () => win,
  };
}
