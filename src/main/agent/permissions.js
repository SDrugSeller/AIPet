// @ts-check
// 도구 실행 권한 정책 (DESIGN.md 4.4).
//  - 작업 폴더 밖의 경로는 거부
//  - 읽기 전용 도구는 설정에 따라 자동 허용
//  - 웹 검색(WebSearch)은 설정(autoAllowWeb)에 따라 자동 허용
//  - 파일 쓰기·수정(autoAllowEdit), 명령 실행(autoAllowShell), 웹 페이지 가져오기(autoAllowFetch)도 설정으로 자동 허용할 수
//    있다(기본은 모두 묻는다). 자동 허용한 일은 `auto`에 한 줄 설명을 달아 돌려주고, 호출한 쪽이 대화창에 흔적을 남긴다
//  - 목록에 없는 도구(MCP 등)는 어떤 설정에서도 항상 묻는다
//  - 작업 폴더 밖의 경로는 자동 허용 설정과 상관없이 항상 거부한다
import fs from 'node:fs';
import path from 'node:path';

/** 파일을 바꾸지 않는 도구 */
const READ_ONLY_TOOLS = new Set(['Read', 'Glob', 'Grep', 'LS', 'NotebookRead']);

/** 설정으로 자동 허용할 수 있는 웹 도구: 검색만 (검색어만 나간다) */
const WEB_SEARCH_TOOLS = new Set(['WebSearch']);

/** 파일을 만들거나 바꾸는 도구 (경로 검사로 작업 폴더 안에서만 허용된다) */
const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);

/** 명령 실행 도구. 명령이 건드리는 경로는 검사할 수 없어서 작업 폴더 밖도 건드릴 수 있다 */
const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);

/** 웹 페이지를 가져오는 도구: 주소(쿼리 문자열)로 정보가 새어 나갈 수 있다 */
const FETCH_TOOLS = new Set(['WebFetch']);

/** 입력에서 경로로 취급하는 키 */
const PATH_KEYS = ['file_path', 'path', 'notebook_path'];

/** 존재하는 가장 가까운 상위 폴더를 실제 경로(심볼릭 링크 해석)로 바꿔 놓는다. @param {string} p */
function realish(p) {
  let cur = path.resolve(p);
  const rest = [];
  while (true) {
    try {
      return path.join(fs.realpathSync(cur), ...rest.reverse());
    } catch {
      const parent = path.dirname(cur);
      if (parent === cur) return path.resolve(p);
      rest.push(path.basename(cur));
      cur = parent;
    }
  }
}

/** target이 root 안(또는 root 자신)인가 @param {string} root @param {string} target */
export function isInside(root, target) {
  const rel = path.relative(realish(root), realish(target));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * @typedef {{ action: 'allow' | 'deny' | 'ask', reason?: string, auto?: boolean }} Decision
 *   auto: 사용자에게 묻지 않고 설정에 따라 허용한 파일 수정/명령 실행/페이지 가져오기 (대화창에 흔적을 남긴다)
 * @typedef {{
 *   autoAllowRead: boolean, autoAllowWeb?: boolean, autoAllowEdit?: boolean, autoAllowShell?: boolean,
 *   autoAllowFetch?: boolean, workDir: string,
 * }} Policy
 * @param {{ name: string, input: any }} req
 * @param {Policy} policy
 * @returns {Decision}
 */
export function decide({ name, input }, { autoAllowRead, autoAllowWeb, autoAllowEdit, autoAllowShell, autoAllowFetch, workDir }) {
  for (const key of PATH_KEYS) {
    const p = input?.[key];
    if (typeof p === 'string' && p && !isInside(workDir, path.resolve(workDir, p))) {
      return { action: 'deny', reason: `작업 폴더(${workDir}) 밖의 경로라서 거부했어요. 설정에서 작업 폴더를 바꿀 수 있어요.` };
    }
  }
  if (autoAllowRead && READ_ONLY_TOOLS.has(name)) return { action: 'allow' };
  if (autoAllowWeb && WEB_SEARCH_TOOLS.has(name)) return { action: 'allow' };
  if (autoAllowEdit && EDIT_TOOLS.has(name)) return { action: 'allow', auto: true };
  if (autoAllowShell && SHELL_TOOLS.has(name)) return { action: 'allow', auto: true };
  if (autoAllowFetch && FETCH_TOOLS.has(name)) return { action: 'allow', auto: true };
  return { action: 'ask' };
}

/** @param {unknown} v @param {number} max */
const clip = (v, max) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v) ?? '';
  return s.length > max ? `${s.slice(0, max)}…` : s;
};

/**
 * 승인 카드에 보여 줄 제목/내용. 사용자가 무엇을 허용하는지 알 수 있어야 한다.
 * @param {string} name @param {any} input
 * @returns {{ title: string, detail: string }}
 */
export function describeRequest(name, input) {
  switch (name) {
    case 'Bash':
    case 'PowerShell':
      return { title: `명령 실행 (${name})`, detail: clip(input?.command, 600) };
    case 'Write':
      return { title: '파일 쓰기', detail: `${clip(input?.file_path, 300)}\n\n${clip(input?.content, 300)}` };
    case 'Edit':
    case 'MultiEdit':
      return { title: '파일 수정', detail: `${clip(input?.file_path, 300)}\n\n${clip(input?.old_string ?? input?.edits, 300)}` };
    case 'NotebookEdit':
      return { title: '노트북 수정', detail: clip(input?.notebook_path, 300) };
    case 'WebFetch':
      return { title: '웹 페이지 가져오기', detail: clip(input?.url, 400) };
    case 'WebSearch':
      return { title: '웹 검색', detail: clip(input?.query, 400) };
    default:
      return { title: `도구 사용 (${name})`, detail: clip(input, 500) };
  }
}
