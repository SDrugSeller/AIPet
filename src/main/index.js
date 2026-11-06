// @ts-check
import { app, protocol, safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConfig } from './config.js';
import { buildMenuTemplate } from './menu.js';
import { createPersonaStore } from './personas.js';
import { createSettingsWindow } from './settingsWindow.js';
import { configureSkinRoots, loadSkin, registerSkinProtocol, SKIN_SCHEME, skinSheetPath } from './skin.js';
import { createStore } from './store.js';
import { createTray } from './tray.js';
import { createOverlayManager } from './windows.js';

const here = path.dirname(fileURLToPath(import.meta.url));

protocol.registerSchemesAsPrivileged([
  { scheme: SKIN_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // 창이 모두 닫혀도(디스플레이 재구성 등) 종료하지 않는다. 종료는 트레이/펫 메뉴의 "종료"로 한다.
  app.on('window-all-closed', () => {});

  app.whenReady().then(async () => {
    registerSkinProtocol();
    const userData = app.getPath('userData');
    // 사용자가 추가하는 스킨 폴더: userData/skins/<이름>/skin.json (설정 창에서 폴더를 열 수 있다)
    const userSkins = path.join(userData, 'skins');
    try {
      fs.mkdirSync(userSkins, { recursive: true });
    } catch {
      // 만들 수 없어도 번들 스킨은 쓸 수 있다
    }
    configureSkinRoots(userSkins);

    const store = createStore({ file: path.join(userData, 'settings.json'), safeStorage });
    // 말투 파일: userData/personas/*.txt (처음에는 저장소의 personas/ 내용으로 채운다)
    const personas = createPersonaStore({
      dir: path.join(userData, 'personas'),
      seedDir: path.resolve(here, '../../personas'),
    });
    const config = createConfig({ store, personas, userDataDir: userData });

    /** @type {ReturnType<typeof createOverlayManager>} */
    let manager;
    /** @type {ReturnType<typeof createSettingsWindow>} */
    let settings;

    // 트레이와 펫 우클릭이 같은 메뉴를 쓴다. manager/settings는 아래에서 만들어진 뒤에 호출된다.
    /** @param {string} [petId] */
    const getMenuTemplate = (petId) =>
      buildMenuTemplate({
        petId,
        isVisible: manager.isVisible,
        setVisible: manager.setVisible,
        isDnd: () => store.get().general.doNotDisturb,
        setDnd: (v) => store.update({ general: { doNotDisturb: v } }),
        connections: () => store.get().connections,
        statuses: manager.statuses,
        setConnectionEnabled: (id, enabled) =>
          store.update({ connections: store.get().connections.map((c) => (c.id === id ? { ...c, enabled } : c)) }),
        listPersonas: () => personas.list(),
        selectPersona: (connectionId, personaId) =>
          store.update({ connections: store.get().connections.map((c) => (c.id === connectionId ? { ...c, persona: personaId } : c)) }),
        openSettings: (tab) => settings.open(tab),
        refreshAll: manager.refreshAll,
      });

    manager = createOverlayManager({
      preloadPath: path.join(here, '../preload/preload.cjs'),
      rendererPath: path.join(here, '../renderer/index.html'),
      debug: process.env.AIPET_DEBUG === '1',
      store,
      config,
      // AIPET_SKIN을 주면 모든 연결이 그 스킨을 쓴다 (디버그/검증용)
      loadSkin: (name, tuning) => loadSkin(process.env.AIPET_SKIN || name, tuning),
      getMenuTemplate,
    });

    settings = createSettingsWindow({
      store,
      config,
      personas,
      manager,
      userDataDir: userData,
      preloadPath: path.join(here, '../preload/settingsPreload.cjs'),
      htmlPath: path.join(here, '../settings/index.html'),
      packaged: app.isPackaged,
    });

    // 트레이 아이콘은 첫 번째 연결의 스킨으로 만든다. 불러오지 못하면 기본 스킨을 쓴다.
    const first = store.get().connections.find((c) => c.enabled) ?? store.get().connections[0];
    /** @type {Awaited<ReturnType<typeof loadSkin>>} */
    let iconSkin;
    try {
      iconSkin = await loadSkin(first?.skin ?? 'default', store.get().skinTuning[first?.skin ?? 'default']);
    } catch {
      iconSkin = await loadSkin('default');
    }
    createTray({
      iconPath: skinSheetPath(iconSkin.name, iconSkin.animations.idle.sheet) ?? '',
      frameSize: iconSkin.frameSize,
      hitbox: iconSkin.hitbox,
      getMenuTemplate: () => getMenuTemplate(),
      onToggle: () => manager.setVisible(!manager.isVisible()),
    });

    // 설정이 바뀔 때마다: 로그인 시 자동 시작 반영, 열려 있는 설정 창 갱신
    store.onChange((s) => {
      // 개발 중(electron.exe 직접 실행)에는 시작 프로그램에 등록하지 않는다.
      if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: s.general.launchAtLogin });
      settings.pushState();
    });
    manager.onStatus(() => settings.pushState());

    await manager.start();

    // 디버그용: 설정 창을 열고 렌더링 결과를 PNG로 저장 (AIPET_OPEN_SETTINGS=1, AIPET_CAPTURE_DIR)
    if (process.env.AIPET_DEBUG === '1' && process.env.AIPET_OPEN_SETTINGS === '1') {
      settings.open();
      setTimeout(async () => {
        const w = settings.getWindow();
        const dir = process.env.AIPET_CAPTURE_DIR;
        if (!w || !dir) return;
        // AIPET_SETTINGS_SCROLL=<요소 id>: 그 요소가 있는 탭으로 전환하고 보이도록 스크롤한 뒤 캡처한다
        if (process.env.AIPET_SETTINGS_SCROLL) {
          await w.webContents.executeJavaScript(
            `(() => { const el = document.getElementById(${JSON.stringify(process.env.AIPET_SETTINGS_SCROLL)}); if (!el) return; const p = el.closest('[role=tabpanel]'); if (p) document.getElementById(p.getAttribute('aria-labelledby'))?.click(); el.scrollIntoView(); })()`,
          );
          await new Promise((r) => setTimeout(r, 300));
        }
        const { writeFile } = await import('node:fs/promises');
        await writeFile(path.join(dir, 'settings.png'), (await w.webContents.capturePage()).toPNG());
      }, 4000);
    }

    // 이미 실행 중인데 또 실행하면: 숨겨 둔 펫을 보여 준다.
    app.on('second-instance', () => manager.setVisible(true));
  });
}
