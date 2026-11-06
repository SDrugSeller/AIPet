// @ts-check
// 첫 실행 안내(빈 상태 카드): 쓸 수 있는 AI 연결이 하나도 없을 때 펫이 한 줄로 알려 준다. Electron에 의존하지 않는다.

/** 말풍선에 보여 줄 한 줄 안내 */
export const SETUP_HINT_TEXT =
  '아직 쓸 수 있는 AI가 연결되지 않았어요. Claude Code·Codex·Gemini CLI를 설치하고 로그인하거나, 설정에서 API 키를 입력해 주세요.';

/**
 * 안내를 보여야 하는가: 연결이 하나 이상 있고, 전부 점검이 끝났는데, 그중 쓸 수 있는 게 하나도 없을 때.
 * 점검이 안 끝난 연결이 있으면(아직 모르므로) 보여 주지 않는다.
 * @param {{ checked: boolean, available: boolean }[]} statuses 켜져 있는 연결들의 점검 결과
 */
export function needsSetupHint(statuses) {
  return statuses.length > 0 && statuses.every((s) => s.checked) && !statuses.some((s) => s.available);
}
