// @ts-check
// 자발적 발화: 펫이 먼저 말을 거는 규칙 (DESIGN.md 6장).
//  - 사용자가 부르지 않았는데 말하는 것이므로 기본은 조용히, 옵트인 + 쿨다운 + 방해 금지를 지킨다.
//  - 전체화면 앱(영상/게임/발표) 중이거나 방해 금지일 때, 대화창을 쓰는 중에는 말하지 않는다.
// 시계와 입력은 주입받아서 시간이 흐르는 상황도 테스트할 수 있다.

/** 이 시간(초) 이상 키보드/마우스 입력이 없으면 "쉬는 중"으로 본다 */
export const AWAY_AFTER_SEC = 5 * 60;
/** 정해진 시각 알림은 못 전한 채로 이 시간(분)이 지나면 버린다 */
const REMINDER_GRACE_MIN = 30;

/**
 * @typedef {{ enabled: boolean, breakReminder: boolean, breakAfterMin: number, breakMessage: string, cooldownMin: number,
 *   notifyDone: boolean, reminders: { time: string, text: string, enabled: boolean }[] }} SpontaneousSettings
 * @typedef {{ dnd: boolean, fullscreen: boolean, chatActive: boolean, hidden: boolean }} Quiet
 *   fullscreen: 전체화면 앱/발표 중, chatActive: 대화창이 열려 있거나 응답 중, hidden: 펫이 숨겨져 있음
 * @typedef {'cooldown' | 'scheduled' | 'event'} Kind
 *   cooldown: 쿨다운을 지켜야 하는 자발적 발화 / scheduled: 정해진 시각이라 쿨다운은 무시 / event: 사용자 요청의 결과 알림
 *
 * @param {{
 *   getSettings: () => SpontaneousSettings,
 *   getQuiet: () => Quiet,
 *   idleSeconds: () => number,
 *   show: (msg: { text: string, kind: string }) => void,
 *   now?: () => number,
 * }} deps
 */
export function createNotifier({ getSettings, getQuiet, idleSeconds, show, now = Date.now }) {
  let lastSpoke = 0;
  /** 쉬지 않고 쓰기 시작한 시각 (자리를 비우면 null) */
  /** @type {number | null} */
  let activeSince = null;
  /** 오늘 이미 알린 시각 알림 ("YYYY-MM-DD|HH:MM|문구") */
  /** @type {Set<string>} */
  const fired = new Set();
  /** 조용해야 해서 못 전한 시각 알림 */
  /** @type {{ text: string, until: number }[]} */
  let pendingReminders = [];

  /** @param {Kind} kind */
  function canSpeak(kind) {
    if (!getSettings().enabled) return false;
    const q = getQuiet();
    if (q.dnd || q.fullscreen || q.hidden) return false;
    if (q.chatActive) return false; // 사용자가 이미 펫과 대화 중이거나 응답을 기다리는 중
    if (kind === 'cooldown') return now() - lastSpoke >= getSettings().cooldownMin * 60_000;
    return true;
  }

  /** @param {string} text @param {string} kind */
  function speak(text, kind) {
    lastSpoke = now();
    show({ text, kind });
  }

  const pad = (/** @type {number} */ n) => String(n).padStart(2, '0');

  return {
    /** 30초 정도마다 호출한다. 쉬라는 알림과 정해진 시각 알림을 확인한다. */
    tick() {
      const s = getSettings();
      const t = now();

      // 전체 스위치가 꺼져 있으면 아무것도 하지 않고, 켰을 때 묵은 알림이 한꺼번에 나오지 않게 비운다.
      if (!s.enabled) {
        activeSince = null;
        pendingReminders = [];
        return;
      }

      // 자리를 비웠다가 돌아오면 "쉬지 않고 쓴 시간"을 새로 센다.
      if (idleSeconds() >= AWAY_AFTER_SEC) activeSince = null;
      else if (activeSince === null) activeSince = t;

      if (s.breakReminder && activeSince !== null && t - activeSince >= s.breakAfterMin * 60_000 && canSpeak('cooldown')) {
        activeSince = t; // 다음 알림은 다시 breakAfterMin 뒤에
        speak(s.breakMessage, 'break');
      }

      // 정해진 시각 알림: 그 시각부터 2분 안에 확인되면 새로 알릴 일로 등록한다.
      const d = new Date(t);
      const day = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
      const minutes = d.getHours() * 60 + d.getMinutes();
      for (const r of s.reminders) {
        if (!r.enabled) continue;
        const [h, m] = r.time.split(':').map(Number);
        const at = h * 60 + m;
        const key = `${day}|${r.time}|${r.text}`;
        if (minutes >= at && minutes - at <= 2 && !fired.has(key)) {
          fired.add(key);
          pendingReminders.push({ text: r.text, until: t + REMINDER_GRACE_MIN * 60_000 });
        }
      }
      pendingReminders = pendingReminders.filter((p) => p.until > t);
      if (pendingReminders.length && canSpeak('scheduled')) {
        const next = /** @type {{ text: string }} */ (pendingReminders.shift());
        speak(next.text, 'reminder');
      }
    },

    /**
     * 사용자가 시킨 일이 끝났는데 대화창이 닫혀 있다 → 말풍선으로 알려 준다.
     * @param {{ ok: boolean, text: string }} r
     */
    onTaskDone({ ok, text }) {
      if (!getSettings().notifyDone || !canSpeak('event')) return false;
      const oneLine = String(text ?? '').replace(/\s+/g, ' ').trim();
      const snippet = oneLine.length > 140 ? `${oneLine.slice(0, 140)}…` : oneLine;
      show({ text: ok ? snippet || '다 했어요!' : `문제가 생겼어요: ${snippet}`, kind: 'done' });
      return true;
    },
  };
}
