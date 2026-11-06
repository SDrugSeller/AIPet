// @ts-check
// sandbox 프리로드는 CommonJS여야 한다. 필요한 API만 contextBridge로 노출한다.
// 펫이 여러 마리이므로 펫에 관한 요청은 모두 petId(연결 id)를 함께 보낸다.
const { contextBridge, ipcRenderer } = require('electron');

/** main → renderer 이벤트 구독 헬퍼 @param {string} channel @param {(payload: any) => void} cb */
const on = (channel, cb) => {
  ipcRenderer.on(channel, (_e, payload) => cb(payload));
};

contextBridge.exposeInMainWorld('aipet', {
  init: () => ipcRenderer.invoke('overlay:init'),
  /** true면 이 창이 마우스를 받고, false면 클릭이 아래 앱으로 통과한다. */
  setInteractive: (/** @type {boolean} */ v) => ipcRenderer.send('overlay:set-interactive', v),
  setDragging: (/** @type {string} */ petId, /** @type {boolean} */ v) => ipcRenderer.send('pet:dragging', petId, v),
  /** 드래그 없이 펫을 클릭했다 (대화창 열기/닫기) */
  petClick: (/** @type {string} */ petId) => ipcRenderer.send('pet:click', petId),
  showMenu: (/** @type {string} */ petId) => ipcRenderer.send('pet:menu', petId),

  chatSend: (/** @type {string} */ petId, /** @type {string} */ text) => ipcRenderer.send('chat:send', petId, text),
  chatAbort: (/** @type {string} */ petId) => ipcRenderer.send('chat:abort', petId),
  chatClose: (/** @type {string} */ petId) => ipcRenderer.send('chat:close', petId),
  /** 입력창을 눌렀다: 키보드 포커스가 필요하다 (권한 요청으로 자동으로 열린 말풍선일 때) */
  chatFocus: (/** @type {string} */ petId) => ipcRenderer.send('chat:focus', petId),
  /** 도구 사용 승인 카드의 허용/거부 */
  permRespond: (/** @type {string} */ petId, /** @type {string} */ id, /** @type {boolean} */ allow) =>
    ipcRenderer.send('perm:respond', petId, id, allow),
  /** 알림 말풍선의 버튼: 'open'(대화하기) | 'close' */
  noticeAction: (/** @type {string} */ petId, /** @type {'open' | 'close' | 'settings'} */ a) => ipcRenderer.send('notice:action', petId, a),

  /** 펫 목록이 바뀌었다 (연결 추가/삭제/켜기/끄기, 이름·스킨 변경) */
  onPetsSync: (/** @type {(list: any[]) => void} */ cb) => on('pets:sync', cb),
  onPetState: (/** @type {(s: any) => void} */ cb) => on('pet:state', cb),
  onBounds: (/** @type {(b: any) => void} */ cb) => on('overlay:bounds', cb),
  /** 앱이 직접 읽은 커서 위치(화면 좌표). 이 창 밖이면 null. 마우스 이동 이벤트가 오지 않을 때의 보조 경로 */
  onCursor: (/** @type {(c: { x: number, y: number } | null) => void} */ cb) => on('overlay:cursor', cb),
  onChatState: (/** @type {(s: any) => void} */ cb) => on('chat:state', cb),
  onChatUser: (/** @type {(m: any) => void} */ cb) => on('chat:user', cb),
  onAgentEvent: (/** @type {(e: any) => void} */ cb) => on('agent:event', cb),
  onNoticeShow: (/** @type {(n: any) => void} */ cb) => on('notice:show', cb),
  onNoticeHide: (/** @type {(n: any) => void} */ cb) => on('notice:hide', cb),
  onPermRequest: (/** @type {(r: any) => void} */ cb) => on('perm:request', cb),
  onPermResolved: (/** @type {(r: any) => void} */ cb) => on('perm:resolved', cb),
});
