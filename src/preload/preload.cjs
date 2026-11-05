// @ts-check
// sandbox 프리로드는 CommonJS여야 한다. 필요한 API만 contextBridge로 노출한다.
const { contextBridge, ipcRenderer } = require('electron');

/** main → renderer 이벤트 구독 헬퍼 @param {string} channel @param {(payload: any) => void} cb */
const on = (channel, cb) => {
  ipcRenderer.on(channel, (_e, payload) => cb(payload));
};

contextBridge.exposeInMainWorld('aipet', {
  init: () => ipcRenderer.invoke('overlay:init'),
  /** true면 이 창이 마우스를 받고, false면 클릭이 아래 앱으로 통과한다. */
  setInteractive: (/** @type {boolean} */ v) => ipcRenderer.send('overlay:set-interactive', v),
  setDragging: (/** @type {boolean} */ v) => ipcRenderer.send('pet:dragging', v),
  /** 드래그 없이 펫을 클릭했다 (대화창 열기/닫기) */
  petClick: () => ipcRenderer.send('pet:click'),
  showMenu: () => ipcRenderer.send('pet:menu'),

  chatSend: (/** @type {string} */ text) => ipcRenderer.send('chat:send', text),
  chatAbort: () => ipcRenderer.send('chat:abort'),
  chatClose: () => ipcRenderer.send('chat:close'),

  onPetState: (/** @type {(s: any) => void} */ cb) => on('pet:state', cb),
  onBounds: (/** @type {(b: any) => void} */ cb) => on('overlay:bounds', cb),
  onChatState: (/** @type {(s: any) => void} */ cb) => on('chat:state', cb),
  onChatUser: (/** @type {(m: any) => void} */ cb) => on('chat:user', cb),
  onAgentEvent: (/** @type {(e: any) => void} */ cb) => on('agent:event', cb),
});
