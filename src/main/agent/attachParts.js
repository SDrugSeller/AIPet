// @ts-check
// 첨부 파일을 각 연결이 받을 수 있는 모양으로 바꾼다. Electron에 의존하지 않는다.
//   inline  파일 내용을 요청에 직접 싣는다: 이미지/PDF는 base64 블록, 글 파일은 본문에 붙인다
//   path    파일 경로를 안내 글로 알려 준다 (파일을 읽을 수 있는 도구가 있는 CLI용)
import fs from 'node:fs';
import { buildPathNote, imageMime, INLINE_TOTAL_MB, inlineTextBlock, planFor } from '../../shared/attachments.js';

/**
 * @typedef {{ name: string, path: string, size: number, kind: string }} AttachInput
 * @typedef {{ kind: 'image' | 'pdf', name: string, mime: string, data: string }} BinaryBlock
 * @typedef {{
 *   binary: BinaryBlock[],
 *   textBlocks: string[],
 *   pathFiles: AttachInput[],
 *   notes: string[],
 * }} Prepared
 */

/**
 * @param {AttachInput[]} files
 * @param {import('../../shared/attachments.js').AttachMode} mode
 * @param {{ tools?: boolean, readFile?: (p: string) => Promise<Buffer> }} [opts]
 * @returns {Promise<Prepared>}
 */
export async function prepareAttachments(files, mode, { tools = true, readFile = (p) => fs.promises.readFile(p) } = {}) {
  /** @type {Prepared} */
  const out = { binary: [], textBlocks: [], pathFiles: [], notes: [] };
  let inlineBytes = 0;
  for (const f of files) {
    const plan = planFor({ name: f.name, size: f.size }, mode, { tools });
    if ('reject' in plan) {
      out.notes.push(`${f.name}: ${plan.reject}`);
      continue;
    }
    if (plan.how === 'path') {
      out.pathFiles.push(f);
      continue;
    }
    if (inlineBytes + f.size > INLINE_TOTAL_MB * 1048576) {
      out.notes.push(`${f.name}: 한 번에 보낼 수 있는 합계(${INLINE_TOTAL_MB}MB)를 넘어서 보내지 않았어요`);
      continue;
    }
    try {
      inlineBytes += f.size; // 합계는 파일 크기로 센다 (읽기 전에)
      const buf = await readFile(f.path);
      const mime = imageMime(f.name);
      if (mime) out.binary.push({ kind: 'image', name: f.name, mime, data: buf.toString('base64') });
      else if (f.name.toLowerCase().endsWith('.pdf')) out.binary.push({ kind: 'pdf', name: f.name, mime: 'application/pdf', data: buf.toString('base64') });
      else out.textBlocks.push(inlineTextBlock(f.name, buf.toString('utf8')));
    } catch (e) {
      out.notes.push(`${f.name}: 읽지 못했어요 (${/** @type {Error} */ (e).message})`);
    }
  }
  return out;
}

/** 본문 뒤에 붙일 글: 직접 붙이는 글 파일 + 경로 안내 @param {string} msg @param {Prepared} p */
export function withAttachmentText(msg, p) {
  return [msg, ...p.textBlocks].join('\n\n') + buildPathNote(p.pathFiles);
}

/** 대화 기록에 남길 표시 (이후 대화에서는 내용을 다시 보내지 않는 연결용) @param {string} msg @param {AttachInput[]} files */
export function historyText(msg, files) {
  return files.length ? `${msg}\n(첨부: ${files.map((f) => f.name).join(', ')} — 그 메시지에서만 볼 수 있었어요)` : msg;
}
