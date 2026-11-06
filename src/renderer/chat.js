// @ts-check
// 펫 한 마리의 말풍선 UI(대화창 + 알림 말풍선). 사용자/에이전트 텍스트는 항상 textContent로만 넣는다 (HTML로 해석하지 않음).
// 펫마다 하나씩 만들어지고, 여러 대화창이 동시에 열릴 수 있다. main이 보내는 이벤트는 main.js가 petId로 골라 여기로 넘긴다.

/**
 * @typedef {{ role: 'user' | 'assistant' | 'error' | 'session' | 'trace', text: string }} LogEntry
 * @typedef {{ x: number, y: number, w: number, h: number }} Rect
 * @typedef {{ id: string, title: string, detail: string }} PermRequest
 * @typedef {{ open: boolean, busy: boolean, backend: { label: string } | null, log: LogEntry[], pending: PermRequest[] }} ChatState
 */

/** 말풍선끼리 겹칠 때, 마지막으로 누른 것이 위로 오게 하는 카운터 */
let zCounter = 10;
/** 키보드 포커스를 받아야 하는 대화창 (마지막으로 열거나 누른 것) */
/** @type {{ focusInput: () => void, isShown: () => boolean, bubble: HTMLElement, close: () => void } | null} */
let activeChat = null;

// 창이 포커스를 받으면(대화창을 열었을 때) 활성 대화창의 입력칸으로 포커스를 옮긴다.
window.addEventListener('focus', () => {
  if (activeChat?.isShown()) activeChat.focusInput();
});
/**
 * 열려 있는 대화창의 입력칸으로 키보드 포커스를 되돌린다. 펫을 누르거나 끌면 캔버스가 포커스를 가져가 입력칸이 풀리는데,
 * 창 자체는 계속 포커스를 갖고 있어서 `focus` 이벤트가 다시 오지 않으므로 직접 되돌려야 한다.
 */
export function refocusActiveChat() {
  if (activeChat?.isShown() && document.hasFocus()) activeChat.focusInput();
}

// Esc는 포커스가 들어 있는 대화창만 닫는다.
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && activeChat?.isShown() && activeChat.bubble.contains(document.activeElement)) activeChat.close();
});

/**
 * @param {any} api  preload에서 노출한 API
 * @param {{ id: string, name: string, chat: ChatState }} pet  이 말풍선의 주인
 * @param {HTMLElement} layer  말풍선들을 붙일 곳
 * @param {HTMLTemplateElement} template
 */
export function createChat(api, pet, layer, template) {
  const petId = pet.id;
  const frag = /** @type {DocumentFragment} */ (template.content.cloneNode(true));
  const el = /** @type {HTMLElement} */ (frag.querySelector('.bubble'));
  const notice = /** @type {HTMLElement} */ (frag.querySelector('.notice'));
  /** @param {string} sel */
  const q = (sel) => /** @type {HTMLElement} */ (el.querySelector(sel));
  const logEl = q('.log');
  const nameEl = q('.name');
  const backendEl = q('.backend');
  const form = /** @type {HTMLFormElement} */ (q('.composer'));
  const input = /** @type {HTMLTextAreaElement} */ (q('.input'));
  const sendBtn = /** @type {HTMLButtonElement} */ (q('.send'));
  const closeBtn = q('.close');
  const noticeText = /** @type {HTMLElement} */ (notice.querySelector('.notice-text'));
  layer.append(el, notice);

  let state = pet.chat;
  let shown = false;
  /** 알림 말풍선이 떠 있어야 하는가 (main이 시간을 재서 보이고 숨긴다) */
  let noticeWanted = false;
  let noticeShown = false;
  /** @type {HTMLElement | null} 응답이 채워질 말풍선 (아직 텍스트가 없으면 "…" 표시) */
  let pending = null;
  /** 승인 대기 중인 카드 @type {Map<string, HTMLElement>} */
  const cards = new Map();
  /** @type {Rect | null} 화면에 놓인 말풍선의 위치 (호버 판정용) */
  let box = null;
  let layoutKey = '';
  let sizeDirty = true;

  /** @param {HTMLElement} target */
  const raise = (target) => (target.style.zIndex = String(++zCounter));

  /** @param {LogEntry['role']} role @param {string} text @param {HTMLElement | null} [before] 이 요소 앞에 끼워 넣는다 */
  function addMessage(role, text, before = null) {
    const m = document.createElement('div');
    m.className = `msg ${role}`;
    m.textContent = text;
    if (before && before.parentNode === logEl) before.before(m);
    else logEl.append(m);
    while (logEl.children.length > 30) logEl.firstElementChild?.remove();
    logEl.scrollTop = logEl.scrollHeight;
    return m;
  }

  /** 도구 사용 승인 카드. 내용은 textContent로만 넣는다. @param {PermRequest} req */
  function addPermCard(req) {
    if (cards.has(req.id)) return;
    const card = document.createElement('div');
    card.className = 'perm';
    const title = document.createElement('strong');
    title.textContent = req.title;
    const detail = document.createElement('pre');
    detail.textContent = req.detail;
    const actions = document.createElement('div');
    actions.className = 'actions';
    const allow = document.createElement('button');
    allow.type = 'button';
    allow.textContent = '허용';
    allow.className = 'allow';
    const deny = document.createElement('button');
    deny.type = 'button';
    deny.textContent = '거부';
    allow.addEventListener('click', () => api.permRespond(petId, req.id, true));
    deny.addEventListener('click', () => api.permRespond(petId, req.id, false));
    actions.append(allow, deny);
    card.append(title, detail, actions);
    logEl.append(card);
    logEl.scrollTop = logEl.scrollHeight;
    cards.set(req.id, card);
  }

  /** @param {{ id: string, allow: boolean, auto?: boolean }} r */
  function resolvePermCard(r) {
    const card = cards.get(r.id);
    if (!card) return;
    cards.delete(r.id);
    card.classList.add('resolved');
    const actions = card.querySelector('.actions');
    if (actions) actions.textContent = r.auto ? '취소됐어요' : r.allow ? '허용했어요' : '거부했어요';
  }

  function renderMeta() {
    nameEl.textContent = pet.name;
    backendEl.textContent = state.backend ? '' : '· 연결 확인 필요';
    sendBtn.textContent = state.busy ? '■' : '↑';
    sendBtn.title = state.busy ? '중단' : '보내기 (Enter)';
    sendBtn.setAttribute('aria-label', sendBtn.title);
  }

  function focusInput() {
    setTimeout(() => {
      if (shown) input.focus();
    }, 60);
  }

  function autosize() {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 96)}px`;
  }

  function submit() {
    const text = input.value.trim();
    if (!text || state.busy) return;
    api.chatSend(petId, text);
    input.value = '';
    autosize();
  }

  const self = { focusInput, isShown: () => shown, bubble: el, close: () => api.chatClose(petId) };

  // --- 이벤트 ---

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (state.busy) api.chatAbort(petId);
    else submit();
  });
  input.addEventListener('input', autosize);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submit();
    }
  });
  closeBtn.addEventListener('click', () => api.chatClose(petId));
  input.addEventListener('pointerdown', () => api.chatFocus(petId));
  // 이 대화창을 누르면 위로 올리고, 키보드 포커스를 받을 대화창으로 삼는다.
  el.addEventListener('pointerdown', () => {
    raise(el);
    activeChat = self;
  });
  notice.addEventListener('pointerdown', () => raise(notice));
  new ResizeObserver(() => (sizeDirty = true)).observe(el);
  new ResizeObserver(() => (sizeDirty = true)).observe(notice);

  // 알림 말풍선의 버튼
  /** @param {string} sel */
  const nq = (sel) => /** @type {HTMLElement} */ (notice.querySelector(sel));
  // 설정 안내(kind 'setup')는 "대화하기" 대신 "설정 열기"로 이어진다
  let noticeKind = '';
  const noticeAct = () => api.noticeAction(petId, noticeKind === 'setup' ? 'settings' : 'open');
  nq('.notice-open').addEventListener('click', noticeAct);
  nq('.notice-close').addEventListener('click', () => api.noticeAction(petId, 'close'));
  noticeText.addEventListener('click', noticeAct); // 말풍선을 누르면 대화(또는 설정)로 이어진다

  // 처음 열린 창에 이미 있는 대화 기록
  for (const e of pet.chat.log) addMessage(e.role, e.text);
  for (const p of pet.chat.pending ?? []) addPermCard(p);
  renderMeta();

  return {
    /** main이 알려 준 대화 상태 (열림/응답 중/연결 정보) @param {ChatState} s */
    handleState(s) {
      state = { ...state, open: s.open, busy: s.busy, backend: s.backend };
      renderMeta();
    },

    /** 사용자가 보낸 메시지 @param {{ text: string }} m */
    handleUser(m) {
      addMessage('user', m.text);
      pending = addMessage('assistant', '…');
      pending.classList.add('typing');
    },

    /** 에이전트 이벤트 (텍스트 조각, 오류, 끝) @param {any} ev */
    handleAgent(ev) {
      if (ev.type === 'text') {
        if (!pending) pending = addMessage('assistant', '');
        if (pending.classList.contains('typing')) {
          pending.classList.remove('typing');
          pending.textContent = '';
        }
        pending.textContent += ev.delta;
        logEl.scrollTop = logEl.scrollHeight;
      } else if (ev.type === 'error') {
        if (pending && pending.classList.contains('typing')) pending.remove();
        pending = null;
        addMessage('error', ev.message);
      } else if (ev.type === 'done') {
        if (pending && pending.classList.contains('typing')) pending.remove(); // 빈 응답
        pending = null;
      } else if (ev.type === 'trace') {
        // 묻지 않고 자동 허용한 일. 응답 자리("…")가 있으면 그 앞에 둔다.
        addMessage('trace', ev.text, pending);
      } else if (ev.type === 'session') {
        // 대화 맥락이 끊겼다는 구분선. 응답 자리("…")가 이미 있으면 그 앞에 둬서 순서가 뒤집히지 않게 한다.
        addMessage('session', ev.text, pending);
      }
    },

    handlePermRequest: addPermCard,
    handlePermResolved: resolvePermCard,

    /** @param {{ text: string, kind?: string }} n */
    showNotice(n) {
      noticeKind = n.kind ?? '';
      nq('.notice-open').textContent = noticeKind === 'setup' ? '설정 열기' : '대화하기';
      noticeText.textContent = n.text;
      noticeWanted = true;
      layoutKey = '';
    },
    hideNotice() {
      noticeWanted = false;
    },

    /** 이름이 바뀌었다 @param {string} name */
    setName(name) {
      pet.name = name;
      renderMeta();
    },

    /**
     * 매 프레임 호출. 펫 위(hit)에 말풍선을 놓는다. hit이 null이면(펫이 다른 모니터) 숨긴다.
     * @param {Rect | null} hit @param {number} viewW @param {number} viewH
     */
    layout(hit, viewW, viewH) {
      const visible = !!hit && state.open;
      if (visible !== shown) {
        shown = visible;
        el.hidden = !visible;
        layoutKey = '';
        box = null;
        if (visible) {
          raise(el);
          activeChat = self;
          focusInput();
        } else if (activeChat === self) {
          activeChat = null;
        }
      }
      // 대화창이 열려 있으면 알림 말풍선은 필요 없다
      const noticeVisible = !!hit && !state.open && noticeWanted;
      if (noticeVisible !== noticeShown) {
        noticeShown = noticeVisible;
        notice.hidden = !noticeVisible;
        layoutKey = '';
        box = null;
      }
      const active = visible ? el : noticeVisible ? notice : null;
      if (!active || !hit) return;

      const key = `${hit.x.toFixed(1)}|${hit.y.toFixed(1)}|${hit.w}|${viewW}|${viewH}`;
      if (key === layoutKey && !sizeDirty) return;
      layoutKey = key;
      sizeDirty = false;

      const w = active.offsetWidth;
      const h = active.offsetHeight;
      const cx = hit.x + hit.w / 2;
      const left = Math.min(Math.max(cx - w / 2, 8), Math.max(8, viewW - w - 8));
      const top = Math.max(8, hit.y - h - 10);
      active.style.transform = `translate(${left}px, ${top}px)`;
      active.style.setProperty('--tail', `${Math.min(Math.max(cx - left, 18), w - 18)}px`);
      box = { x: left, y: top, w, h };
    },

    /** 말풍선이 이 좌표를 덮고 있는가 (마우스를 받아야 하는 영역) @param {number} x @param {number} y */
    contains(x, y) {
      return !!box && x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h;
    },

    /** 펫이 사라졌다: 말풍선도 치운다. */
    dispose() {
      if (activeChat === self) activeChat = null;
      el.remove();
      notice.remove();
    },
  };
}
