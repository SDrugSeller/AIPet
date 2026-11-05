// @ts-check
import { Menu, Tray, nativeImage } from 'electron';

/**
 * 시스템 트레이 아이콘. 스킨의 idle 첫 프레임을 아이콘으로 쓴다.
 * 왼쪽 클릭은 펫 숨김/보임 전환, 오른쪽 클릭은 메뉴.
 * @param {{
 *   iconPath: string,
 *   frameSize: { w: number, h: number },
 *   getMenuTemplate: () => Electron.MenuItemConstructorOptions[],
 *   onToggle: () => void,
 * }} opts
 */
export function createTray({ iconPath, frameSize, getMenuTemplate, onToggle }) {
  const full = nativeImage.createFromPath(iconPath);
  const frame = full.isEmpty() ? full : full.crop({ x: 0, y: 0, width: frameSize.w, height: frameSize.h });
  const icon = frame.isEmpty() ? frame : frame.resize({ width: 32, height: 32 });

  const tray = new Tray(icon);
  tray.setToolTip('AIPet');
  tray.on('click', onToggle);
  // 상태(숨김 여부, AI 연결)가 바뀌므로 메뉴는 열 때마다 새로 만든다.
  tray.on('right-click', () => tray.popUpContextMenu(Menu.buildFromTemplate(getMenuTemplate())));
  return tray;
}
