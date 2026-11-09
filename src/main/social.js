// @ts-check
// 펫끼리 어울리기: 깨어서 한가한 펫이 같은 모니터에서 자고 있는 펫을 깨우러 간다.
// 엔진 두 개를 함께 움직여야 해서 개별 엔진이 아니라 여기서 조정한다. 시계와 난수는 주입받아 테스트할 수 있다.

/** 후보를 살피는 간격 */
export const SOCIAL_TICK_MS = 5_000;
/** 같은 두 펫(방향과 무관)은 이 시간 안에 최대 PAIR_MAX_VISITS번까지만 어울린다 (깨웠다 재웠다가 끝없이 이어지지 않도록) */
export const PAIR_WINDOW_MS = 5 * 60_000;
export const PAIR_MAX_VISITS = 3;
/** 잠든 지 이만큼은 지나야 깨우러 간다 (막 잠든 펫을 바로 깨우지 않는다) */
export const MIN_SLEEP_MS = 10_000;
/** 후보 쌍이 있을 때 이번 차례에 실제로 가 볼 확률 */
export const VISIT_CHANCE = 0.5;
/** 방문이 이보다 길어지면 뭔가 잘못된 것으로 보고 상태를 풀어 준다 */
const STUCK_MS = 90_000;

/** @param {string} a @param {string} b */
const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/**
 * @typedef {ReturnType<typeof import('./petEngine.js').createPetEngine>} PetEngine
 * @param {{
 *   getPets: () => { id: string, engine: PetEngine }[],
 *   enabled: () => boolean,
 *   log?: (message: string) => void,
 *   now?: () => number,
 *   rand?: () => number,
 * }} deps
 */
export function createSocial({ getPets, enabled, log = () => {}, now = Date.now, rand = Math.random }) {
  /** @type {Map<string, number[]>} 두 펫의 id(정렬해서 "a|b") → 최근 방문을 시작한 시각들 */
  const visits = new Map();

  /** 이 쌍이 최근 PAIR_WINDOW_MS 안에 방문한 횟수 (오래된 기록은 지운다) @param {string} key */
  function recentVisits(key) {
    const recent = (visits.get(key) ?? []).filter((t) => now() - t < PAIR_WINDOW_MS);
    visits.set(key, recent);
    return recent;
  }
  /** @type {{ since: number } | null} */
  let active = null;
  /** @type {NodeJS.Timeout | null} */
  let timer = null;

  /** 한 번 살펴보고, 조건이 맞으면 한 쌍을 보낸다. 보냈으면 true. */
  function tick() {
    if (active && now() - active.since > STUCK_MS) active = null;
    if (active || !enabled()) return false;
    const pets = getPets();
    if (pets.length < 2) return false;

    const sleepers = pets.filter((p) => p.engine.sleeping && p.engine.sleptFor() >= MIN_SLEEP_MS);
    if (!sleepers.length) return false;
    const visitors = pets.filter((p) => p.engine.canVisit);

    const pairs = [];
    for (const v of visitors) {
      for (const s of sleepers) {
        if (v.id === s.id || v.engine.pet.display !== s.engine.pet.display) continue;
        if (recentVisits(pairKey(v.id, s.id)).length >= PAIR_MAX_VISITS) continue;
        pairs.push({ v, s });
      }
    }
    if (!pairs.length || rand() >= VISIT_CHANCE) return false;

    const { v, s } = pairs[Math.min(pairs.length - 1, Math.floor(rand() * pairs.length))];
    const started = v.engine.visit({
      toward: s.engine.pet.x,
      // 도착했을 때 상대가 그대로 자고 있고 같은 모니터에 있어야 깨운다
      shouldNudge: () => s.engine.sleeping && s.engine.pet.display === v.engine.pet.display,
      onNudge: () => {
        const woke = s.engine.wakeUp(v.engine.pet.x);
        log(`${v.id}이(가) ${s.id}을(를) ${woke ? '깨움' : '깨우려 했지만 이미 깨어 있었음'}`);
      },
      onEnd: (reason) => {
        active = null;
        if (reason !== 'done') log(`${v.id}의 방문 ${reason === 'skipped' ? '생략 (도착했을 때 상대가 자고 있지 않음)' : '취소 (다른 동작이 끼어듦)'}`);
      },
    });
    if (!started) return false;
    recentVisits(pairKey(v.id, s.id)).push(now());
    active = { since: now() };
    log(`${v.id}이(가) 자고 있는 ${s.id}을(를) 깨우러 감`);
    return true;
  }

  return {
    tick,
    /** 사라진 펫과의 쌍 기록은 정리하지 않아도 크기가 작다. 타이머만 끝낸다. */
    start() {
      if (!timer) {
        timer = setInterval(tick, SOCIAL_TICK_MS);
        timer.unref?.();
      }
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
    /** 방문 진행 중인가 (테스트/디버그용) */
    get busy() {
      return active !== null;
    },
  };
}
