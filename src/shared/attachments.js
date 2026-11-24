// @ts-check
// 대화에 파일을 끌어다 놓아 첨부하는 기능의 규칙. 제한값과 "어떤 연결이 어떤 파일을 어떻게 받는가"를 한곳에 모았다.
// main(복사·검사), 어댑터(요청 만들기), 설정 화면, 테스트가 함께 쓴다. Electron에 의존하지 않는다.
//
// 제한값은 이 파일의 상수에서만 바꾸면 된다. 사용자가 설정 화면에서 바꾸는 것은 파일당 크기와 개수뿐이고
// (settings.json의 attachments), 코드에 고정된 상한(ATTACH_CAPS)을 넘지 못한다.
import path from 'node:path';

/** 기본 제한: 파일당 5MB, 한 번에 5개 */
export const ATTACH_DEFAULTS = Object.freeze({ maxFileMb: 5, maxFiles: 5 });
/** 설정에서 올릴 수 있는 상한 (코드에 고정) */
export const ATTACH_CAPS = Object.freeze({ maxFileMb: 50, maxFiles: 10 });
/** 한 대화(복사본이 지워지기 전까지)에 쌓일 수 있는 복사본의 합계(MB) */
export const ATTACH_TOTAL_MB = 100;
/** 파일 내용을 요청에 직접 싣는 연결(API, 도구를 끈 Claude Code)이 받는 글 파일의 한도(KB). 글 파일이 너무 크면 AI가 한 번에 읽을 수 없다 */
export const INLINE_TEXT_MAX_KB = 200;
/** 요청에 직접 싣는 파일들의 합계(MB). base64로 약 33% 커진 것이 API 요청 한도(32MB) 안에 들어와야 한다 */
export const INLINE_TOTAL_MB = 20;

/** @typedef {'image' | 'pdf' | 'text' | 'other'} FileKind */
/** @typedef {'claude' | 'path' | 'anthropic' | 'openai'} AttachMode */

const IMAGE_MIME = /** @type {Record<string, string>} */ ({ '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp' });
const TEXT_EXT = new Set([
  '.txt', '.md', '.markdown', '.json', '.jsonl', '.csv', '.tsv', '.log', '.xml', '.yml', '.yaml', '.toml', '.ini', '.cfg', '.conf', '.html', '.htm', '.css',
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.java', '.kt', '.c', '.h', '.cpp', '.hpp', '.cs', '.go', '.rs', '.rb', '.php', '.sh', '.bat', '.ps1',
  '.sql', '.vue', '.svelte', '.tex', '.rst', '.srt', '.env', '.gitignore',
]);

/** 확장자로 종류를 가른다 @param {string} name @returns {FileKind} */
export function kindOf(name) {
  const ext = path.extname(name).toLowerCase();
  if (ext in IMAGE_MIME) return 'image';
  if (ext === '.pdf') return 'pdf';
  if (TEXT_EXT.has(ext)) return 'text';
  return 'other';
}

/** 이미지의 MIME 형식 (이미지가 아니면 null) @param {string} name @returns {string | null} */
export const imageMime = (name) => IMAGE_MIME[path.extname(name).toLowerCase()] ?? null;

/** 연결 종류에 맞는 첨부 방식: claude(이미지·PDF·작은 글은 직접 싣고 나머지는 경로), path(경로로 알려 줌), anthropic/openai(직접 싣기만 가능) @param {string} kind @returns {AttachMode} */
export function modeFor(kind) {
  switch (kind) {
    case 'claude-code':
      return 'claude';
    case 'anthropic-api':
      return 'anthropic';
    case 'openai-compat':
      return 'openai';
    default:
      return 'path'; // codex-cli, gemini-cli
  }
}

/**
 * 이 파일을 어떻게 AI에게 줄 수 있는가. 줄 수 없으면 이유를 돌려준다 (끌어다 놓는 순간 사용자에게 보여 준다).
 * @param {{ name: string, size: number }} file
 * @param {AttachMode} mode
 * @param {{ tools?: boolean }} [opts] tools: Claude Code가 파일을 읽는 도구를 쓸 수 있는가
 * @returns {{ how: 'inline' | 'path' } | { reject: string }}
 */
export function planFor(file, mode, { tools = true } = {}) {
  const kind = kindOf(file.name);
  const smallText = file.size <= INLINE_TEXT_MAX_KB * 1024;
  switch (mode) {
    case 'path':
      return { how: 'path' };
    case 'claude':
      if (kind === 'image' || kind === 'pdf') return { how: 'inline' };
      if (kind === 'text' && smallText) return { how: 'inline' };
      if (tools) return { how: 'path' };
      return { reject: kind === 'text' ? `글 파일이 커서(${INLINE_TEXT_MAX_KB}KB 초과) 이 연결은 읽을 수 없어요. 연결의 "파일·명령 도구 사용"을 켜면 읽을 수 있어요` : '이 연결은 이미지, PDF, 글 파일만 읽을 수 있어요 (도구 사용을 켜면 다른 파일도 읽어요)' };
    case 'anthropic':
      if (kind === 'image' || kind === 'pdf') return { how: 'inline' };
      if (kind === 'text') return smallText ? { how: 'inline' } : { reject: `글 파일이 너무 커요 (${INLINE_TEXT_MAX_KB}KB까지). 이 연결은 파일 내용을 대화에 직접 붙여서 보내요` };
      return { reject: '이 연결은 이미지, PDF, 글 파일만 읽을 수 있어요' };
    case 'openai':
      if (kind === 'image') return { how: 'inline' };
      if (kind === 'text') return smallText ? { how: 'inline' } : { reject: `글 파일이 너무 커요 (${INLINE_TEXT_MAX_KB}KB까지). 이 연결은 파일 내용을 대화에 직접 붙여서 보내요` };
      return { reject: '이 연결은 이미지와 글 파일만 읽을 수 있어요 (PDF는 안 돼요)' };
    default:
      return { reject: '지원하지 않는 연결이에요' };
  }
}

/** 설정에서 온 제한값을 안전한 범위로 맞춘다 @param {{ maxFileMb?: unknown, maxFiles?: unknown } | null | undefined} v */
export function normalizeLimits(v) {
  const clamp = (/** @type {unknown} */ x, /** @type {number} */ def, /** @type {number} */ cap) => (Number.isInteger(x) && /** @type {number} */ (x) >= 1 ? Math.min(/** @type {number} */ (x), cap) : def);
  return { maxFileMb: clamp(v?.maxFileMb, ATTACH_DEFAULTS.maxFileMb, ATTACH_CAPS.maxFileMb), maxFiles: clamp(v?.maxFiles, ATTACH_DEFAULTS.maxFiles, ATTACH_CAPS.maxFiles) };
}

/** 사람이 읽는 크기 @param {number} bytes */
export function formatSize(bytes) {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10 * 1024 ? 1 : 0)}KB`;
  return `${(bytes / 1048576).toFixed(1)}MB`;
}

/** 복사본 파일 이름으로 쓸 수 있게 다듬는다 (경로 구분자, 윈도우에서 못 쓰는 글자, 너무 긴 이름 제거) @param {string} name */
export function safeFileName(name) {
  // 윈도우에서 못 쓰는 글자와 제어 문자(코드 32 미만)는 밑줄로 바꾼다
  const cleaned = [...path.basename(String(name))].map((ch) => (ch.charCodeAt(0) < 32 || '<>:"/|?*'.includes(ch) || ch === String.fromCharCode(92) ? '_' : ch)).join('');
  const base = cleaned.replace(/^\.+/, '').replace(/[ .]+$/, '');
  const ext = path.extname(base);
  const stem = base.slice(0, base.length - ext.length).slice(0, 80);
  return `${stem || 'file'}${ext.slice(0, 16)}`;
}

/**
 * 경로로 알려 줄 파일들을 안내 글로 만든다 (파일을 읽을 수 있는 도구가 있는 연결용).
 * @param {{ name: string, path: string, size: number }[]} files
 */
export function buildPathNote(files) {
  if (!files.length) return '';
  const lines = files.map((f) => `- ${f.name} (${formatSize(f.size)}): ${f.path}`);
  return `\n\n[사용자가 이 대화에 첨부한 파일입니다. 위 요청에 필요하면 아래 경로의 파일을 읽어 주세요. 이 파일들은 대화가 끝나면 지워집니다.]\n${lines.join('\n')}`;
}

/** 글 파일 내용을 요청 본문에 붙일 때의 모양 @param {string} name @param {string} text */
export function inlineTextBlock(name, text) {
  return `[첨부 파일: ${name}]\n\`\`\`\n${text.replace(/```/g, '`​``')}\n\`\`\``;
}
