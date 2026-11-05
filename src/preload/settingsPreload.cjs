// @ts-check
// 설정 창 전용 preload. API 키 값은 렌더러로 돌려주지 않는다 (저장/삭제만 가능).
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('aipetSettings', {
  get: () => ipcRenderer.invoke('settings:get'),
  set: (/** @type {object} */ patch) => ipcRenderer.invoke('settings:set', patch),
  /** value가 null이면 삭제 */
  setSecret: (/** @type {string} */ name, /** @type {string | null} */ value) => ipcRenderer.invoke('settings:secret', name, value),
  select: (/** @type {string} */ id) => ipcRenderer.invoke('settings:select', id),
  recheck: () => ipcRenderer.invoke('settings:recheck'),
  personaSave: (/** @type {string} */ id, /** @type {string} */ text) => ipcRenderer.invoke('settings:persona-save', id, text),
  personaCreate: (/** @type {string} */ name, /** @type {string} */ text) => ipcRenderer.invoke('settings:persona-create', name, text),
  personaDelete: (/** @type {string} */ id) => ipcRenderer.invoke('settings:persona-delete', id),
  personaOpenFolder: () => ipcRenderer.invoke('settings:persona-open-folder'),
  pickDir: () => ipcRenderer.invoke('settings:pick-dir'),
  onState: (/** @type {(s: any) => void} */ cb) => {
    ipcRenderer.on('settings:state', (_e, s) => cb(s));
  },
});
