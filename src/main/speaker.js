// @ts-check
// 먼저 말을 거는 펫 고르기: 펫들이 돌아가며 말하되, 깨어 있는 펫을 먼저 고른다.
//  - 정해진 펫이 없는 알림(쉬라는 안내, 정해진 시각 알림)에만 쓴다. 작업이 끝난 알림은 일한 펫이 직접 말한다.
//  - 순서는 펫 목록 순서이고, 마지막으로 말한 펫 다음부터 훑는다.
//  - 깨어 있는 펫이 하나도 없으면(모두 자는 중) 자는 펫이라도 순서대로 돌아가며 말한다.

/**
 * @param {{ ids: string[], isAwake: (id: string) => boolean, lastId: string | null }} p
 *   ids: 펫 목록 순서, lastId: 직전에 말한 펫(없거나 이미 사라졌으면 처음부터)
 * @returns {string | null} 말할 펫. 펫이 없으면 null
 */
export function pickSpeaker({ ids, isAwake, lastId }) {
  if (!ids.length) return null;
  const start = lastId === null ? 0 : (ids.indexOf(lastId) + 1) % ids.length; // indexOf가 -1이면 0부터
  const order = [...ids.slice(start), ...ids.slice(0, start)];
  return order.find(isAwake) ?? order[0];
}
