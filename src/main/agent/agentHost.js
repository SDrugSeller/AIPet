// @ts-check
// 에이전트 호스트: 어댑터 목록/선택, 한 번에 한 대화, AgentEvent → UI 중계 + 펫 모션 매핑 (DESIGN.md 5.3).

const MAX_LOG = 20;

/**
 * @typedef {{ role: 'user' | 'assistant' | 'error', text: string }} LogEntry
 *
 * @param {{
 *   adapters: import('./adapter.js').AgentAdapter[],
 *   engine: {
 *     poke: () => void,
 *     setHold: (hold: boolean) => void,
 *     setAgentAnim: (name: string | null, opts?: { once?: boolean }) => void,
 *   },
 *   broadcast: (channel: string, payload: any) => void,
 *   onOpenChange?: (open: boolean) => void,
 *   preferred?: string,
 * }} opts
 */
export function createAgentHost({ adapters, engine, broadcast, onOpenChange, preferred }) {
  /** @type {Map<string, import('./adapter.js').DetectResult>} */
  const detected = new Map();
  /** @type {string | null} */
  let selected = null;
  let userChose = false;
  let open = false;
  let busy = false;
  /** @type {LogEntry[]} */
  const log = [];
  /** @type {import('./adapter.js').AgentAdapter | null} */
  let running = null;

  /** @param {string} id */
  const byId = (id) => adapters.find((a) => a.id === id) ?? null;

  function backends() {
    return adapters.map((a) => ({
      id: a.id,
      label: a.label,
      available: detected.get(a.id)?.ok ?? false,
      reason: detected.get(a.id)?.reason ?? '',
      selected: a.id === selected,
    }));
  }

  function snapshot() {
    const cur = selected ? byId(selected) : null;
    return { open, busy, backend: cur ? { id: cur.id, label: cur.label } : null, log: log.map((e) => ({ ...e })) };
  }

  function emitState() {
    broadcast('chat:state', snapshot());
  }

  /** @param {LogEntry} entry */
  function pushLog(entry) {
    log.push(entry);
    if (log.length > MAX_LOG) log.shift();
  }

  /** 사용 가능한 첫 백엔드를 고른다. 사용자가 직접 고른 것이 아니면 상황에 맞게 바꾼다. */
  function autoSelect() {
    if (userChose && selected && detected.get(selected)?.ok) return;
    const order = preferred ? [preferred, ...adapters.map((a) => a.id)] : adapters.map((a) => a.id);
    const pick = order.find((id) => detected.get(id)?.ok);
    if (pick) selected = pick;
    else if (!userChose) selected = null;
  }

  async function refresh() {
    await Promise.all(
      adapters.map(async (a) => {
        try {
          detected.set(a.id, await a.detect());
        } catch (e) {
          detected.set(a.id, { ok: false, reason: String(/** @type {Error} */ (e).message ?? e) });
        }
      }),
    );
    autoSelect();
    emitState();
  }

  /** 사용 가능한 백엔드가 없을 때 사용자에게 보여 줄 안내 */
  function noBackendMessage() {
    const lines = adapters.map((a) => `· ${a.label}: ${detected.get(a.id)?.reason || '사용할 수 없어요'}`);
    return `사용할 수 있는 AI 연결이 없어요.\n${lines.join('\n')}`;
  }

  /** 에이전트 이벤트 → 펫 모션 (think/work/talk/done/error) */
  let anim = '';
  /** @param {string | null} name */
  function setAnim(name) {
    if (name && name === anim) return;
    anim = name ?? '';
    engine.setAgentAnim(name);
  }

  /** @param {import('./adapter.js').AgentEvent} ev */
  function handle(ev) {
    broadcast('agent:event', ev);
    switch (ev.type) {
      case 'status':
        if (ev.state === 'thinking') setAnim('think');
        else if (ev.state === 'working') setAnim('work');
        break;
      case 'text': {
        const last = log[log.length - 1];
        if (last?.role === 'assistant') last.text += ev.delta;
        else pushLog({ role: 'assistant', text: ev.delta });
        setAnim('talk');
        break;
      }
      case 'done':
        anim = '';
        engine.setAgentAnim('done', { once: true });
        break;
      case 'error':
        pushLog({ role: 'error', text: ev.message });
        anim = '';
        engine.setAgentAnim('error', { once: true });
        break;
    }
  }

  /** @param {string} text */
  async function send(text) {
    text = String(text ?? '').trim().slice(0, 8000);
    if (!text || busy) return;
    busy = true;
    pushLog({ role: 'user', text });
    broadcast('chat:user', { text });
    emitState();
    engine.poke();
    setAnim('think');

    let finished = false;
    try {
      let adapter = selected ? byId(selected) : null;
      if (!adapter || !detected.get(adapter.id)?.ok) {
        await refresh(); // 그 사이에 CLI를 로그인했거나 Ollama를 켰을 수 있다
        adapter = selected ? byId(selected) : null;
      }
      if (!adapter || !detected.get(adapter.id)?.ok) {
        handle({ type: 'error', message: noBackendMessage() });
        finished = true;
        return;
      }

      running = adapter;
      for await (const ev of adapter.send(text)) {
        if (ev.type === 'done' || ev.type === 'error') finished = true;
        handle(ev);
      }
      if (!finished) {
        // 중단 등으로 끝 이벤트 없이 종료됨
        broadcast('agent:event', { type: 'done', aborted: true });
        setAnim(null);
      }
    } catch (e) {
      handle({ type: 'error', message: String(/** @type {Error} */ (e).message ?? e) });
    } finally {
      running = null;
      busy = false;
      emitState();
    }
  }

  return {
    refresh,
    backends,
    snapshot,
    send,

    get isOpen() {
      return open;
    },

    /** @param {boolean} value */
    setOpen(value) {
      if (open === value) return;
      open = value;
      engine.setHold(open);
      engine.poke();
      onOpenChange?.(open);
      emitState();
    },

    abort() {
      running?.abort();
    },

    /** @param {string} id */
    select(id) {
      if (!byId(id) || id === selected) return;
      selected = id;
      userChose = true;
      for (const a of adapters) a.reset?.();
      emitState();
    },

    dispose() {
      running?.abort();
    },
  };
}
