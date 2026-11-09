// @ts-check
// 잠들기까지의 시간 규칙. 엔진(main)과 설정 창(renderer)이 같은 값을 쓰도록 공용 모듈로 둔다.

/** 사용자가 정할 수 있는 "잠들기까지" 시간(초)의 범위와 기본값 */
export const SLEEP_AFTER_MIN_SEC = 10;
export const SLEEP_AFTER_MAX_SEC = 3600;
export const SLEEP_AFTER_DEFAULT_SEC = 60;

/** 다른 펫이 깨운 펫은 사용자가 건드렸을 때의 이만큼(2/3)만 깨어 있다가 다시 잠든다. 고정값이다. */
export const WAKE_AWAKE_RATIO = 2 / 3;

/**
 * 다른 펫이 깨운 뒤 다시 잠들기까지의 시간(ms).
 * @param {number} sleepAfterMs 사용자가 건드렸을 때의 잠들기까지 시간 (잠들지 않으면 Infinity)
 */
export const wakeAwakeMs = (sleepAfterMs) => (Number.isFinite(sleepAfterMs) ? sleepAfterMs * WAKE_AWAKE_RATIO : Infinity);
