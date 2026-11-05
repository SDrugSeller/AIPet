// @ts-check
// 말풍선 대화 UI. 사용자/에이전트 텍스트는 항상 textContent로만 넣는다 (HTML로 해석하지 않음).

/**
 * @typedef {{ role: 'user' | 'assistant' | 'error', text: string }} LogEntry
 * @typedef {{ x: number, y: number, w: number, h: number }} Rect
 *
 * @param {any} api  preload에서 노출한 API
 * @param {{ open: boolean, busy: boolean, backend: { label: string } | null, log: LogEntry[] }} initial
 */
export function createChat(api, initial) {
  const el = /** @type {HTMLElement} */ (document.getElementById('bubble'));
  const logEl = /** @type {HTMLElement} */ (document.getElementById('log'));
  const backendEl = /** @type {HTMLElement} */ (document.getElementById('backend'));
  const form = /** @type {HTMLFormElement} */ (document.getElementById('composer'));
  const input = /** @type {HTMLTextAreaElement} */ (document.getElementById('input'));
  const sendBtn = /** @type {HTMLButtonElement} */ (document.getElementById('send'));
  const closeBtn = /** @type {HTMLButtonElement} */ (document.getElementById('close'));

  let state = initial;
  let shown = false;
  /** @type {HTMLElement | null} 응답이 채워질 말풍선 (아직 텍스트가 없으면 "…" 표시) */
  let pending = null;
  /** @type {Rect | null} 화면에 놓인 말풍선의 위치 (호버 판정용) */
  let box = null;
  let layoutKey = '';
  let sizeDirty = true;

  /** @param {LogEntry['role']} role @param {string} text */
  function addMessage(role, text) {
    const m = document.createElement('div');
    m.className = `msg ${role}`;
    m.textContent = text;
    logEl.append(m);
    while (logEl.children.length > 30) logEl.firstElementChild?.remove();
    logEl.scrollTop = logEl.scrollHeight;
    return m;
  }

  function renderMeta() {
    backendEl.textContent = state.backend ? state.backend.label : 'AI 연결 없음 · 펫을 우클릭해 확인하세요';
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
    api.chatSend(text);
    input.value = '';
    autosize();
  }

  // --- 이벤트 ---

  form.addEventListener('submit', (e) => {
    e.preventDefault();
    if (state.busy) api.chatAbort();
    else submit();
  });
  input.addEventListener('input', autosize);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      submit();
    }
  });
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && shown) api.chatClose();
  });
  window.addEventListener('focus', () => {
    if (shown) input.focus();
  });
  closeBtn.addEventListener('click', () => api.chatClose());
  new ResizeObserver(() => (sizeDirty = true)).observe(el);

  api.onChatState((/** @type {typeof state} */ s) => {
    state = { ...state, open: s.open, busy: s.busy, backend: s.backend };
    renderMeta();
  });

  api.onChatUser((/** @type {{ text: string }} */ m) => {
    addMessage('user', m.text);
    pending = addMessage('assistant', '…');
    pending.classList.add('typing');
  });

  api.onAgentEvent((/** @type {any} */ ev) => {
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
    }
  });

  // 처음 열린 창에 이미 있는 대화 기록
  for (const e of initial.log) addMessage(e.role, e.text);
  renderMeta();

  return {
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
        if (visible) focusInput();
      }
      if (!visible || !hit) return;

      const key = `${hit.x.toFixed(1)}|${hit.y.toFixed(1)}|${hit.w}|${viewW}|${viewH}`;
      if (key === layoutKey && !sizeDirty) return;
      layoutKey = key;
      sizeDirty = false;

      const w = el.offsetWidth;
      const h = el.offsetHeight;
      const cx = hit.x + hit.w / 2;
      const left = Math.min(Math.max(cx - w / 2, 8), Math.max(8, viewW - w - 8));
      const top = Math.max(8, hit.y - h - 10);
      el.style.transform = `translate(${left}px, ${top}px)`;
      el.style.setProperty('--tail', `${Math.min(Math.max(cx - left, 18), w - 18)}px`);
      box = { x: left, y: top, w, h };
    },

    /** 말풍선이 이 좌표를 덮고 있는가 (마우스를 받아야 하는 영역) @param {number} x @param {number} y */
    contains(x, y) {
      return !!box && x >= box.x && x <= box.x + box.w && y >= box.y && y <= box.y + box.h;
    },
  };
}
