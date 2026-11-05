// @ts-check
// 에이전트 어댑터 공통 인터페이스. 펫 엔진/UI는 AgentEvent만 소비한다.
// 각 어댑터는 자기 백엔드의 출력 형식을 AgentEvent로 변환한다. (DESIGN.md 4.1)

/**
 * @typedef {{ type: 'text', delta: string }
 *   | { type: 'tool_request', id: string, name: string, input: any }
 *   | { type: 'status', state: 'thinking' | 'working' | 'idle' }
 *   | { type: 'done' }
 *   | { type: 'error', message: string }} AgentEvent
 */

/** @typedef {{ ok: boolean, reason?: string }} DetectResult */

/**
 * @typedef {Object} AgentAdapter
 * @property {string} id
 * @property {string} label  사용자에게 보이는 이름
 * @property {() => Promise<DetectResult>} detect  설치/로그인/서버 연결 점검
 * @property {(msg: string, ctx?: object) => AsyncIterable<AgentEvent>} send
 * @property {(id: string, allow: boolean) => void} respondPermission
 * @property {() => void} abort
 * @property {() => void} [reset]  대화 맥락 초기화
 */

/** 펫 페르소나. 모든 어댑터가 공통으로 쓴다. */
export const PERSONA = [
  "You are a small, friendly pet living on the user's desktop.",
  'Keep replies short: one to three sentences, warm and conversational.',
  'Reply in the same language the user writes in.',
  'You currently cannot use tools or access files, so do not offer to.',
].join(' ');

/**
 * push/close로 값을 밀어 넣고 for await로 읽는 단순 큐. 콜백 기반 스트림을 AsyncIterable로 바꾼다.
 * @template T
 */
export function createQueue() {
  /** @type {T[]} */
  const items = [];
  /** @type {(() => void) | null} */
  let wake = null;
  let closed = false;
  const notify = () => {
    const w = wake;
    wake = null;
    w?.();
  };
  return {
    /** @param {T} item */
    push(item) {
      items.push(item);
      notify();
    },
    close() {
      closed = true;
      notify();
    },
    async *[Symbol.asyncIterator]() {
      while (true) {
        if (items.length) {
          yield /** @type {T} */ (items.shift());
        } else if (closed) {
          return;
        } else {
          await new Promise((resolve) => (wake = /** @type {() => void} */ (resolve)));
        }
      }
    },
  };
}
