// @ts-check
import { app, protocol } from 'electron';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createOverlayManager } from './windows.js';
import { loadSkin, registerSkinProtocol, SKIN_SCHEME } from './skin.js';

const here = path.dirname(fileURLToPath(import.meta.url));

protocol.registerSchemesAsPrivileged([
  { scheme: SKIN_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // 트레이가 생기기 전(M4)까지는 펫 우클릭 메뉴로 종료한다.
  // 오버레이 창이 잠시 0개가 되는 경우(디스플레이 재구성)에도 앱이 종료되지 않게 한다.
  app.on('window-all-closed', () => {});

  app.whenReady().then(async () => {
    registerSkinProtocol();
    const skin = await loadSkin('default');
    createOverlayManager({
      skin,
      preloadPath: path.join(here, '../preload/preload.cjs'),
      rendererPath: path.join(here, '../renderer/index.html'),
      debug: process.env.AIPET_DEBUG === '1',
    });
  });
}
