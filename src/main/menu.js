// @ts-check
import { app } from 'electron';

/**
 * 트레이와 펫 우클릭이 함께 쓰는 메뉴.
 * @param {{
 *   host: { backends(): { id: string, label: string, available: boolean, selected: boolean }[], select(id: string): void, refresh(): Promise<void> },
 *   isVisible: () => boolean,
 *   setVisible: (v: boolean) => void,
 *   openSettings: () => void,
 * }} deps
 * @returns {Electron.MenuItemConstructorOptions[]}
 */
export function buildMenuTemplate({ host, isVisible, setVisible, openSettings }) {
  return [
    { label: isVisible() ? '펫 숨기기' : '펫 보이기', click: () => setVisible(!isVisible()) },
    { type: 'separator' },
    { label: 'AI 연결', enabled: false },
    ...host.backends().map((b) => ({
      label: `${b.label}${b.available ? '' : '  (사용 불가)'}`,
      type: /** @type {const} */ ('radio'),
      checked: b.selected,
      click: () => host.select(b.id),
    })),
    { label: '연결 다시 확인', click: () => void host.refresh() },
    { type: 'separator' },
    { label: '설정…', click: openSettings },
    { label: '종료', click: () => app.quit() },
  ];
}
