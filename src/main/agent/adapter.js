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

/**
 * @typedef {Object} DetectResult
 * @property {boolean} ok
 * @property {string} [reason]  사용할 수 없을 때 이유와 해결 안내
 * @property {string} [info]    어떤 계정/주소로 동작하는지 (설정 화면에 표시, DESIGN.md 4.3)
 */

/**
 * @typedef {Object} AgentAdapter
 * @property {string} id
 * @property {string} label  사용자에게 보이는 이름
 * @property {() => Promise<DetectResult>} detect  설치/로그인/서버 연결 점검
 * @property {(msg: string, ctx?: object) => AsyncIterable<AgentEvent>} send
 * @property {(id: string, allow: boolean, message?: string) => void} respondPermission  tool_request에 대한 사용자 응답
 * @property {() => void} abort
 * @property {() => void} [reset]  대화 맥락 초기화
 */

const PERSONA_BASE = [
  "You are a small, friendly pet living on the user's desktop.",
  'Keep replies short: one to three sentences, warm and conversational.',
  'Reply in the same language the user writes in.',
];

/** 도구를 쓸 수 없는 펫 페르소나 */
export const PERSONA = [...PERSONA_BASE, 'You currently cannot use tools or access files, so do not offer to.'].join(' ');

/** 도구를 쓸 수 있는 펫 페르소나. 위험한 동작은 사용자가 승인해야 실행된다. */
export const PERSONA_TOOLS = [
  ...PERSONA_BASE,
  'You can read and edit files and run commands, but only inside the allowed work folder,',
  'and the user must approve risky actions first. If an action is denied, accept it and do not try to work around it.',
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
