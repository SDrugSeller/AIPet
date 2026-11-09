// @ts-check
import { app } from 'electron';
import { KINDS } from '../shared/connections.js';

/**
 * 트레이와 펫 우클릭이 함께 쓰는 메뉴.
 * petId가 있으면(펫을 우클릭) 그 펫의 말투를 바로 고를 수 있고, 없으면(트레이) 펫마다 말투 메뉴를 보여 준다.
 * @param {{
 *   petId?: string,
 *   isVisible: () => boolean,
 *   setVisible: (v: boolean) => void,
 *   isDnd: () => boolean,
 *   setDnd: (v: boolean) => void,
 *   connections: () => import('../shared/connections.js').Connection[],
 *   statuses: () => Record<string, { checked: boolean, available: boolean }>,
 *   setConnectionEnabled: (id: string, enabled: boolean) => void,
 *   listPersonas: () => { id: string, name: string }[],
 *   selectPersona: (connectionId: string, personaId: string) => void,
 *   openSettings: (tab?: string) => void,
 *   refreshAll: () => Promise<void>,
 *   openLogs?: () => void,
 * }} deps
 * @returns {Electron.MenuItemConstructorOptions[]}
 */
export function buildMenuTemplate({ petId, isVisible, setVisible, isDnd, setDnd, connections, statuses, setConnectionEnabled, listPersonas, selectPersona, openSettings, refreshAll, openLogs }) {
  const conns = connections();
  const status = statuses();
  const personas = listPersonas();

  /** @param {import('../shared/connections.js').Connection} c */
  const personaMenu = (c) => ({
    label: petId ? `말투 (${c.name})` : `말투: ${c.name}`,
    enabled: personas.length > 0,
    submenu: personas.map((p) => ({
      label: p.name,
      type: /** @type {const} */ ('radio'),
      checked: p.id === c.persona,
      click: () => selectPersona(c.id, p.id),
    })),
  });

  const shown = conns.filter((c) => c.enabled && (!petId || c.id === petId));

  return [
    { label: isVisible() ? '펫 숨기기' : '펫 보이기', click: () => setVisible(!isVisible()) },
    { label: '방해 금지 (먼저 말 걸지 않기)', type: 'checkbox', checked: isDnd(), click: () => setDnd(!isDnd()) },
    { type: 'separator' },
    {
      label: '연결 (캐릭터)',
      submenu: [
        ...conns.map((c) => {
          const st = status[c.id];
          const suffix = !c.enabled ? '' : !st?.checked ? '  (확인 중…)' : st.available ? '' : '  (사용 불가)';
          return {
            label: `${c.name} · ${KINDS[c.kind].label}${suffix}`,
            type: /** @type {const} */ ('checkbox'),
            checked: c.enabled,
            click: () => setConnectionEnabled(c.id, !c.enabled),
          };
        }),
        ...(conns.length ? [{ type: /** @type {const} */ ('separator') }] : []),
        { label: '연결 다시 확인', click: () => void refreshAll() },
        { label: '연결 추가/관리…', click: () => openSettings('ai') },
      ],
    },
    ...shown.map(personaMenu),
    { type: 'separator' },
    { label: '설정…', click: () => openSettings() },
    ...(openLogs ? [{ label: '동작 로그 폴더 열기 (디버그 빌드)', click: openLogs }] : []),
    { label: '종료', click: () => app.quit() },
  ];
}
