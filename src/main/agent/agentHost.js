// @ts-check
// 에이전트 호스트: 어댑터 목록/선택, 한 번에 한 대화, AgentEvent → UI 중계 + 펫 모션 매핑 (DESIGN.md 5.3),
// 도구 권한 요청 처리 (정책으로 허용/거부/사용자에게 묻기, DESIGN.md 4.4).
import { decide, describeRequest } from './permissions.js';

const MAX_LOG = 20;

/**
 * @typedef {{ role: 'user' | 'assistant' | 'error', text: string }} LogEntry
 * @typedef {{ id: string, title: string, detail: string }} PendingPermission
 *
 * @param {{
 *   adapters: import('./adapter.js').AgentAdapter[],
 *   engine: {
 *     poke: () => void,
 *     setHold: (hold: boolean) => void,
 *     setAgentAnim: (name: string | null, opts?: { once?: boolean }) => void,
 *   },
 *   broadcast: (channel: string, payload: any) => void,
 *   onOpenChange?: (open: boolean, opts: { focus: boolean }) => void,
 *   isEnabled?: (adapterId: string) => boolean,
 *   getPolicy?: () => { autoAllowRead: boolean, workDir: string },
 *   notify?: () => void,
 *   onSelect?: (adapterId: string) => void,
 *   onTaskFinished?: (result: { ok: boolean, text: string }) => void,
 *   preferred?: string | null,
 * }} opts
 */
export function createAgentHost({
  adapters,
  engine,
  broadcast,
  onOpenChange,
  isEnabled = () => true,
  getPolicy = () => ({ autoAllowRead: true, workDir: process.cwd() }),
  notify,
  onSelect,
  onTaskFinished,
  preferred = null,
}) {
  /** @type {Map<string, import('./adapter.js').DetectResult>} */
  const detected = new Map();
  /** 지금 쓰는 백엔드 */
  /** @type {string | null} */
  let selected = null;
  /** 사용자가 고른 백엔드. 쓸 수 있으면 항상 이것을 쓴다. */
  /** @type {string | null} */
  let wanted = preferred;
  let open = false;
  let busy = false;
  /** @type {LogEntry[]} */
  const log = [];
  /** 사용자의 승인을 기다리는 요청 */
  /** @type {Map<string, PendingPermission>} */
  const pending = new Map();
  /** @type {import('./adapter.js').AgentAdapter | null} */
  let running = null;
  /** 이번 대화의 결과 (끝났을 때 대화창이 닫혀 있으면 알려 주기 위해) */
  const turn = { ok: /** @type {boolean | null} */ (null), text: '', aborted: false };

  /** @param {string} id */
  const byId = (id) => adapters.find((a) => a.id === id) ?? null;
  /** @param {string} id */
  const usable = (id) => isEnabled(id) && !!detected.get(id)?.ok;

  function backends() {
    return adapters.map((a) => ({
      id: a.id,
      label: a.label,
      enabled: isEnabled(a.id),
      /** 아직 한 번도 점검하지 않았으면 false */
      checked: detected.has(a.id),
      available: usable(a.id),
      reason: isEnabled(a.id) ? (detected.get(a.id)?.reason ?? '') : '사용 안 함',
      info: detected.get(a.id)?.info ?? '',
      selected: a.id === selected,
    }));
  }

  function snapshot() {
    const cur = selected ? byId(selected) : null;
    return {
      open,
      busy,
      backend: cur ? { id: cur.id, label: cur.label } : null,
      log: log.map((e) => ({ ...e })),
      pending: [...pending.values()],
    };
  }

  function emitState() {
    broadcast('chat:state', snapshot());
  }

  /** @param {LogEntry} entry */
  function pushLog(entry) {
    log.push(entry);
    if (log.length > MAX_LOG) log.shift();
  }

  function autoSelect() {
    if (wanted && usable(wanted)) selected = wanted;
    else if (!(selected && usable(selected))) selected = adapters.map((a) => a.id).find(usable) ?? null;
  }

  async function refresh() {
    await Promise.all(
      adapters.map(async (a) => {
        if (!isEnabled(a.id)) {
          detected.set(a.id, { ok: false, reason: '사용 안 함' });
          return;
        }
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
    const lines = adapters.map((a) => `· ${a.label}: ${backends().find((b) => b.id === a.id)?.reason || '사용할 수 없어요'}`);
    return `사용할 수 있는 AI 연결이 없어요.\n${lines.join('\n')}`;
  }

  // --- 펫 모션 매핑 (think/work/talk/attention/done/error) ---

  let anim = '';
  /** @param {string | null} name */
  function setAnim(name) {
    if (name && name === anim) return;
    anim = name ?? '';
    engine.setAgentAnim(name);
  }

  // --- 권한 요청 ---

  /** @param {boolean} value @param {{ focus?: boolean }} [opts] */
  function setOpen(value, { focus = true } = {}) {
    if (open === value) return;
    open = value;
    engine.setHold(open);
    engine.poke();
    onOpenChange?.(open, { focus: value && focus });
    emitState();
  }

  /** 정책으로 바로 정할 수 있으면 응답하고, 아니면 사용자에게 묻는다. @param {Extract<import('./adapter.js').AgentEvent, { type: 'tool_request' }>} ev */
  function onToolRequest(ev) {
    const adapter = running;
    if (!adapter) return;
    const d = decide({ name: ev.name, input: ev.input }, getPolicy());
    if (d.action !== 'ask') {
      adapter.respondPermission(ev.id, d.action === 'allow', d.reason);
      return;
    }
    const view = { id: ev.id, ...describeRequest(ev.name, ev.input) };
    pending.set(ev.id, view);
    broadcast('perm:request', view);
    setAnim('attention');
    // 사용자가 다른 앱을 쓰는 중일 수 있으니 포커스는 가져오지 않고 말풍선만 띄운다.
    if (!open) setOpen(true, { focus: false });
    notify?.();
    emitState();
  }

  /** 대기 중인 요청을 모두 정리한다 (대화가 끝났거나 중단됨). */
  function clearPending() {
    for (const id of pending.keys()) broadcast('perm:resolved', { id, allow: false, auto: true });
    pending.clear();
  }

  // --- 대화 ---

  /** @param {import('./adapter.js').AgentEvent} ev */
  function handle(ev) {
    if (ev.type === 'tool_request') return onToolRequest(ev);
    broadcast('agent:event', ev);
    switch (ev.type) {
      case 'status':
        if (pending.size) break; // 승인 대기 중에는 attention 유지
        if (ev.state === 'thinking') setAnim('think');
        else if (ev.state === 'working') setAnim('work');
        break;
      case 'text': {
        turn.text += ev.delta;
        const last = log[log.length - 1];
        if (last?.role === 'assistant') last.text += ev.delta;
        else pushLog({ role: 'assistant', text: ev.delta });
        setAnim('talk');
        break;
      }
      case 'done':
        turn.ok = true;
        anim = '';
        engine.setAgentAnim('done', { once: true });
        break;
      case 'error':
        turn.ok = false;
        turn.text = ev.message;
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
    turn.ok = null;
    turn.text = '';
    turn.aborted = false;
    pushLog({ role: 'user', text });
    broadcast('chat:user', { text });
    emitState();
    engine.poke();
    setAnim('think');

    let finished = false;
    try {
      let adapter = selected ? byId(selected) : null;
      if (!adapter || !usable(adapter.id)) {
        await refresh(); // 그 사이에 CLI를 로그인했거나 Ollama를 켰을 수 있다
        adapter = selected ? byId(selected) : null;
      }
      if (!adapter || !usable(adapter.id)) {
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
      clearPending();
      running = null;
      busy = false;
      emitState();
      // 대화창을 닫아 둔 사이에 끝났다면 사용자는 결과를 못 봤으니 알린다. (중단한 경우는 제외)
      if (!open && !turn.aborted && turn.ok !== null) onTaskFinished?.({ ok: turn.ok, text: turn.text });
    }
  }

  autoSelect();

  return {
    refresh,
    backends,
    snapshot,
    send,

    get isOpen() {
      return open;
    },
    setOpen,

    /** 승인 카드에서 사용자가 누른 응답 @param {string} id @param {boolean} allow */
    respondPermission(id, allow) {
      if (!pending.has(id)) return;
      pending.delete(id);
      running?.respondPermission(id, allow, allow ? undefined : '사용자가 거부했어요. 다른 방법으로 우회하지 말아 주세요.');
      broadcast('perm:resolved', { id, allow });
      setAnim(pending.size ? 'attention' : 'work');
      emitState();
    },

    abort() {
      turn.aborted = true;
      running?.abort();
      clearPending();
    },

    /** 사용자가 고른 AI 연결 @param {string} id */
    select(id) {
      if (!byId(id) || id === selected) return;
      wanted = id;
      selected = id;
      for (const a of adapters) a.reset?.();
      onSelect?.(id);
      emitState();
    },

    dispose() {
      running?.abort();
    },
  };
}
