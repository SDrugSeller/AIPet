// @ts-check
// sandbox 프리로드는 CommonJS여야 한다. 필요한 API만 contextBridge로 노출한다.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('aipet', {
  init: () => ipcRenderer.invoke('overlay:init'),
  /** true면 이 창이 마우스를 받고, false면 클릭이 아래 앱으로 통과한다. */
  setInteractive: (/** @type {boolean} */ v) => ipcRenderer.send('overlay:set-interactive', v),
  setDragging: (/** @type {boolean} */ v) => ipcRenderer.send('pet:dragging', v),
  showMenu: () => ipcRenderer.send('pet:menu'),
  onPetState: (/** @type {(s: any) => void} */ cb) => {
    ipcRenderer.on('pet:state', (_e, s) => cb(s));
  },
  onBounds: (/** @type {(b: any) => void} */ cb) => {
    ipcRenderer.on('overlay:bounds', (_e, b) => cb(b));
  },
});
