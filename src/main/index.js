// @ts-check
import { app, protocol, safeStorage } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createConfig } from './config.js';
import { buildMenuTemplate } from './menu.js';
import { createSettingsWindow } from './settingsWindow.js';
import { loadSkin, registerSkinProtocol, SKIN_SCHEME } from './skin.js';
import { createPersonaStore } from './personas.js';
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

    const store = createStore({ file: path.join(userData, 'settings.json'), safeStorage });
    // 말투 파일: userData/personas/*.txt (처음에는 저장소의 personas/ 내용으로 채운다)
    const personas = createPersonaStore({
      dir: path.join(userData, 'personas'),
      seedDir: path.resolve(here, '../../personas'),
    });
    const config = createConfig({ store, personas, userDataDir: userData });

    // 스킨: AIPET_SKIN > 설정. 불러오지 못하면 기본 스킨으로 시작한다.
    const wantedSkin = process.env.AIPET_SKIN || store.get().general.skin;
    /** @type {Awaited<ReturnType<typeof loadSkin>>} */
    let skin;
    try {
      skin = await loadSkin(wantedSkin);
    } catch (e) {
      console.error(`스킨 '${wantedSkin}'을 불러오지 못해 기본 스킨을 씁니다:`, /** @type {Error} */ (e).message);
      skin = await loadSkin('default');
    }

    /** @type {ReturnType<typeof createOverlayManager>} */
    let manager;
    /** @type {ReturnType<typeof createSettingsWindow>} */
    let settings;

    // 트레이와 펫 우클릭이 같은 메뉴를 쓴다. manager/settings는 아래에서 만들어진 뒤에 호출된다.
    const getMenuTemplate = () =>
      buildMenuTemplate({
        host: manager.host,
        isVisible: manager.isVisible,
        setVisible: manager.setVisible,
        openSettings: () => settings.open(),
        isDnd: () => store.get().general.doNotDisturb,
        setDnd: (v) => store.update({ general: { doNotDisturb: v } }),
        listPersonas: () => personas.list().map((p) => ({ ...p, selected: p.id === store.get().persona.selected })),
        selectPersona: (id) => store.update({ persona: { selected: id } }),
      });

    manager = createOverlayManager({
      skin,
      preloadPath: path.join(here, '../preload/preload.cjs'),
      rendererPath: path.join(here, '../renderer/index.html'),
      debug: process.env.AIPET_DEBUG === '1',
      store,
      config,
      getMenuTemplate,
    });

    settings = createSettingsWindow({
      store,
      config,
      personas,
      host: manager.host,
      preloadPath: path.join(here, '../preload/settingsPreload.cjs'),
      htmlPath: path.join(here, '../settings/index.html'),
      packaged: app.isPackaged,
    });

    createTray({
      iconPath: path.resolve(here, '../../skins', skin.name, skin.animations.idle.sheet),
      frameSize: skin.frameSize,
      hitbox: skin.hitbox,
      getMenuTemplate,
      onToggle: () => manager.setVisible(!manager.isVisible()),
    });

    // 설정이 바뀔 때마다: 로그인 시 자동 시작 반영, 열려 있는 설정 창 갱신
    let skinSetting = store.get().general.skin;
    store.onChange((s) => {
      // 스킨은 시작할 때 한 번 읽으므로, 사용자가 바꾸면 앱을 다시 시작해 적용한다.
      if (s.general.skin !== skinSetting) {
        skinSetting = s.general.skin;
        app.relaunch();
        app.exit(0);
        return;
      }
      // 개발 중(electron.exe 직접 실행)에는 시작 프로그램에 등록하지 않는다.
      if (app.isPackaged) app.setLoginItemSettings({ openAtLogin: s.general.launchAtLogin });
      settings.pushState();
    });

    // 디버그용: 설정 창을 열고 렌더링 결과를 PNG로 저장 (AIPET_OPEN_SETTINGS=1, AIPET_CAPTURE_DIR)
    if (process.env.AIPET_DEBUG === '1' && process.env.AIPET_OPEN_SETTINGS === '1') {
      settings.open();
      setTimeout(async () => {
        const w = settings.getWindow();
        const dir = process.env.AIPET_CAPTURE_DIR;
        if (!w || !dir) return;
        // AIPET_SETTINGS_SCROLL=<요소 id>: 그 요소가 보이도록 스크롤한 뒤 캡처한다
        if (process.env.AIPET_SETTINGS_SCROLL) {
          await w.webContents.executeJavaScript(`document.getElementById(${JSON.stringify(process.env.AIPET_SETTINGS_SCROLL)})?.scrollIntoView()`);
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
