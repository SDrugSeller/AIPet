// @ts-check
// 설정 창 전용 preload. API 키 값은 렌더러로 돌려주지 않는다 (저장/삭제만 가능).
const { contextBridge, ipcRenderer } = require('electron');

const invoke = (/** @type {string} */ channel, /** @type {unknown[]} */ ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld('aipetSettings', {
  get: () => invoke('settings:get'),
  set: (/** @type {object} */ patch) => invoke('settings:set', patch),

  // 연결(캐릭터)
  addConnection: (/** @type {string} */ kind) => invoke('settings:add', kind),
  removeConnection: (/** @type {string} */ id) => invoke('settings:remove', id),
  /** id를 생략하면 모든 연결을 다시 확인한다 */
  recheck: (/** @type {string | undefined} */ id) => invoke('settings:recheck', id),
  /** value가 null이면 삭제 */
  setSecret: (/** @type {string} */ connectionId, /** @type {string | null} */ value) => invoke('settings:secret', connectionId, value),
  loginCommand: (/** @type {string} */ connectionId) => invoke('settings:login-command', connectionId),
  pickDir: () => invoke('settings:pick-dir'),

  // 말투 파일
  personaRead: (/** @type {string} */ id) => invoke('settings:persona-read', id),
  personaSave: (/** @type {string} */ id, /** @type {string} */ text) => invoke('settings:persona-save', id, text),
  personaCreate: (/** @type {string} */ name, /** @type {string} */ text) => invoke('settings:persona-create', name, text),
  personaDelete: (/** @type {string} */ id) => invoke('settings:persona-delete', id),
  personaOpenFolder: () => invoke('settings:persona-open-folder'),

  // 스킨 크기
  skinInfo: (/** @type {string} */ id) => invoke('settings:skin-info', id),

  onState: (/** @type {(s: any) => void} */ cb) => {
    ipcRenderer.on('settings:state', (_e, s) => cb(s));
  },
  onTab: (/** @type {(tab: string) => void} */ cb) => {
    ipcRenderer.on('settings:tab', (_e, tab) => cb(tab));
  },
});
