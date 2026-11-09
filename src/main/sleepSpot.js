// @ts-check
// 펫이 잠들 때 가는 "잠자는 자리". 여기저기 흩어져 자지 않고 한쪽에 나란히 모여 자도록 자리를 정한다.

/** 고를 수 있는 자리: 오른쪽 끝 / 왼쪽 끝 / 가운데 / 있던 자리에서 그대로 */
export const SLEEP_SPOT_MODES = /** @type {const} */ (['right', 'left', 'center', 'here']);
export const SLEEP_SPOT_DEFAULT = 'right';

/** 최대로 늘어놓는 자리 수 (그보다 많으면 있던 자리에서 잔다) */
const MAX_SLOTS = 40;

/**
 * 이 펫이 잠자러 갈 곳(발 x)을 정한다. 끝에서부터 가장 가까운 빈 자리이고, 다른 펫이 자고 있거나 가는 중인 자리는 피한다.
 * @param {{
 *   mode: string,
 *   area: { left: number, right: number } | null,
 *   step: number,
 *   taken: number[],
 * }} opts
 *   area: 이 모니터에서 펫이 설 수 있는 발 x 범위 / step: 펫 한 마리가 차지하는 폭 / taken: 같은 모니터에서 다른 펫이 자고 있거나 자러 가는 x
 * @returns {number | null} null이면 있던 자리에서 그대로 잔다
 */
export function sleepSpotX({ mode, area, step, taken }) {
  if (!area || mode === 'here' || !SLEEP_SPOT_MODES.includes(/** @type {any} */ (mode))) return null;
  const center = (area.left + area.right) / 2;
  /** @param {number} i */
  const slotX = (i) => {
    if (mode === 'left') return area.left + i * step;
    if (mode === 'center') return center + (i % 2 ? 1 : -1) * Math.ceil(i / 2) * step; // 가운데, 오른쪽, 왼쪽, ...
    return area.right - i * step;
  };
  for (let i = 0; i < MAX_SLOTS; i++) {
    const x = Math.min(Math.max(slotX(i), area.left), area.right);
    if (!taken.some((t) => Math.abs(t - x) < step * 0.6)) return x;
  }
  return null;
}
