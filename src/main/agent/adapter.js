// @ts-check
// 에이전트 어댑터 공통 인터페이스. 펫 엔진/UI는 AgentEvent만 소비한다.
// 각 어댑터는 자기 백엔드의 출력 형식을 AgentEvent로 변환한다. (DESIGN.md 4.1)

/**
 * @typedef {{ type: 'text', delta: string }
 *   | { type: 'tool_request', id: string, name: string, input: any }
 *   | { type: 'status', state: 'thinking' | 'working' | 'idle' }
 *   | { type: 'done' }
 *   | { type: 'error', message: string }
 *   | { type: 'session', text: string }} AgentEvent
 *   session: 대화 맥락이 끊겼다는 표시 (세션 만료, 설정 변경으로 새 대화 시작 등). 대화창에 구분선으로 남는다.
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

/** 말투를 고르지 못했을 때 쓰는 기본 말투 (personas/기본.txt와 같은 내용) */
export const DEFAULT_PERSONA =
  '너는 사용자의 데스크톱 화면에 사는 작고 친근한 펫이야. 한두 문장으로 짧고 따뜻하게, 대화하듯 답해. 사용자가 쓰는 언어로 답해.';

const TOOLS_OFF = 'You currently cannot use tools or access files, so do not offer to.';
const TOOLS_READONLY = [
  'You may read files inside the allowed work folder, but you cannot modify files or run risky commands,',
  'so do not offer to. Keep answers short.',
].join(' ');
const WEB_ON = 'You may use web search when the question needs current or external information.';
const WEB_OFF = 'Do not use web search or browse the web.';
const TOOLS_ON = [
  'You can read and edit files and run commands, but only inside the allowed work folder,',
  'and the user must approve risky actions first. If an action is denied, accept it and do not try to work around it.',
].join(' ');

/**
 * 시스템 프롬프트 = 사용자가 고른 말투 + 앱이 정하는 도구 사용 안내.
 * (말투는 설정의 말투 파일에서 오므로 사용자가 자유롭게 바꿀 수 있다.)
 * @param {string | undefined} persona
 * @param {boolean | 'readonly'} tools  false: 도구 없음(대화 전용) / 'readonly': 읽기만 가능 / true: 쓰기·실행도 가능(승인 후)
 * @param {{ web?: boolean }} [opts]  web: 웹 검색을 써도 되는가 ('readonly' 모드에서만 안내에 쓴다)
 */
export function buildSystemPrompt(persona, tools, { web = false } = {}) {
  // 읽기 전용 CLI(Codex, Gemini)는 승인 질문을 할 수 없어서, 웹 검색을 쓸지는 설정으로만 정하고 모델에게도 알려 준다.
  const tail = tools === 'readonly' ? `${TOOLS_READONLY} ${web ? WEB_ON : WEB_OFF}` : tools ? TOOLS_ON : TOOLS_OFF;
  return `${(persona || '').trim() || DEFAULT_PERSONA}\n\n${tail}`;
}

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
