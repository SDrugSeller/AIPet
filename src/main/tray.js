// @ts-check
import { Menu, Tray, nativeImage } from 'electron';

/**
 * 시스템 트레이 아이콘. 스킨의 idle 첫 프레임을 아이콘으로 쓴다.
 * 왼쪽 클릭은 펫 숨김/보임 전환, 오른쪽 클릭은 메뉴.
 * @param {{
 *   iconPath: string,
 *   frameSize: { w: number, h: number },
 *   hitbox: { x: number, y: number, w: number, h: number },
 *   getMenuTemplate: () => Electron.MenuItemConstructorOptions[],
 *   onToggle: () => void,
 * }} opts
 */
export function createTray({ iconPath, frameSize, hitbox, getMenuTemplate, onToggle }) {
  const full = nativeImage.createFromPath(iconPath);
  // 캐릭터 몸통이 아이콘을 꽉 채우도록, 히트박스 중심의 정사각형 영역을 잘라 쓴다.
  const side = Math.min(Math.max(hitbox.w, hitbox.h), frameSize.w, frameSize.h);
  const x = Math.round(Math.min(Math.max(hitbox.x + hitbox.w / 2 - side / 2, 0), frameSize.w - side));
  const y = Math.round(Math.min(Math.max(hitbox.y + hitbox.h / 2 - side / 2, 0), frameSize.h - side));
  const frame = full.isEmpty() ? full : full.crop({ x, y, width: side, height: side });
  const icon = frame.isEmpty() ? frame : frame.resize({ width: 32, height: 32, quality: 'best' });

  const tray = new Tray(icon);
  tray.setToolTip('AIPet');
  tray.on('click', onToggle);
  // 상태(숨김 여부, AI 연결)가 바뀌므로 메뉴는 열 때마다 새로 만든다.
  tray.on('right-click', () => tray.popUpContextMenu(Menu.buildFromTemplate(getMenuTemplate())));
  return tray;
}
