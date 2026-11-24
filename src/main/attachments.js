// @ts-check
// 대화에 첨부한 파일의 복사본을 관리한다. Electron에 의존하지 않는다.
//
// 원본은 건드리지 않고 userData/attachments/<연결 id>/ 아래에 복사해서 쓴다. 이 폴더는 읽기 전용으로만 AI에게 열린다(권한 정책의 readRoots).
// 복사본은 그 대화가 끝날 때(새 대화, 앱 종료)와 앱을 켤 때 지운다: PC가 대화 도중 꺼졌어도 다음에 켤 때 남은 것을 정리한다.
import fs from 'node:fs';
import path from 'node:path';
import { ATTACH_TOTAL_MB, formatSize, kindOf, modeFor, normalizeLimits, planFor, safeFileName } from '../shared/attachments.js';

/**
 * @typedef {{ id: string, name: string, size: number, kind: import('../shared/attachments.js').FileKind, path: string, how: 'inline' | 'path' }} AttachedFile
 * @typedef {{ name: string, reason: string }} Rejected
 */

/**
 * @param {{ root: string, getLimits: () => { maxFileMb?: unknown, maxFiles?: unknown }, fsp?: typeof fs.promises }} opts
 */
export function createAttachmentStore({ root, getLimits, fsp = fs.promises }) {
  /** 아직 보내지 않은 첨부 (입력창 위의 칩들) @type {Map<string, AttachedFile[]>} */
  const pending = new Map();
  /** 이 대화에서 복사해 둔 바이트 합계 (보낸 것 포함) @type {Map<string, number>} */
  const stored = new Map();
  let seq = 0;

  /** @param {string} petId */
  const dirOf = (petId) => path.join(root, petId);

  /** 연결 id가 폴더 이름으로 안전한가 @param {string} petId */
  const safeId = (petId) => /^[a-z0-9][a-z0-9-]{0,31}$/.test(petId);

  return {
    root,

    /** 아직 보내지 않은 첨부 목록 @param {string} petId @returns {AttachedFile[]} */
    list: (petId) => [...(pending.get(petId) ?? [])],

    /**
     * 파일들을 복사해서 첨부한다. 안 되는 파일은 이유와 함께 돌려준다.
     * @param {string} petId
     * @param {string[]} srcPaths 끌어다 놓은 원본 파일의 경로
     * @param {{ kind: string, tools?: boolean }} conn 이 대화의 연결 종류 (어떻게 첨부할 수 있는지 정한다)
     * @returns {Promise<{ added: AttachedFile[], rejected: Rejected[] }>}
     */
    async add(petId, srcPaths, conn) {
      /** @type {AttachedFile[]} */
      const added = [];
      /** @type {Rejected[]} */
      const rejected = [];
      if (!safeId(petId)) return { added, rejected: [{ name: '', reason: '연결을 알 수 없어요' }] };
      const limits = normalizeLimits(getLimits());
      const mode = modeFor(conn.kind);
      const list = pending.get(petId) ?? [];
      let total = stored.get(petId) ?? 0;

      for (const src of srcPaths.slice(0, 50)) {
        const name = typeof src === 'string' ? path.basename(src) : '';
        /** @param {string} reason */
        const no = (reason) => void rejected.push({ name, reason });
        if (typeof src !== 'string' || !path.isAbsolute(src) || src.length > 1000) {
          no('파일 경로를 읽지 못했어요');
          continue;
        }
        let st;
        try {
          st = await fsp.stat(src);
        } catch {
          no('파일을 열 수 없어요');
          continue;
        }
        if (!st.isFile()) {
          no('폴더는 첨부할 수 없어요 (파일만 가능해요)');
          continue;
        }
        if (st.size === 0) {
          no('빈 파일이에요');
          continue;
        }
        if (list.length + added.length >= limits.maxFiles) {
          no(`한 번에 ${limits.maxFiles}개까지만 첨부할 수 있어요`);
          continue;
        }
        if (st.size > limits.maxFileMb * 1048576) {
          no(`너무 커요 (${formatSize(st.size)}, 최대 ${limits.maxFileMb}MB)`);
          continue;
        }
        if (total + st.size > ATTACH_TOTAL_MB * 1048576) {
          no(`이 대화에 첨부한 파일이 너무 많아요 (합계 ${ATTACH_TOTAL_MB}MB까지). 새 대화를 시작하면 비워져요`);
          continue;
        }
        const plan = planFor({ name, size: st.size }, mode, { tools: conn.tools !== false });
        if ('reject' in plan) {
          no(plan.reject);
          continue;
        }
        const dir = dirOf(petId);
        const dest = path.join(dir, `${++seq}-${safeFileName(name)}`);
        if (path.relative(root, dest).startsWith('..')) {
          no('허용하지 않는 경로예요');
          continue;
        }
        try {
          await fsp.mkdir(dir, { recursive: true });
          await fsp.copyFile(src, dest);
        } catch (e) {
          no(`복사하지 못했어요 (${/** @type {Error} */ (e).message})`);
          continue;
        }
        total += st.size;
        added.push({ id: `a${seq}`, name: safeFileName(name), size: st.size, kind: kindOf(name), path: dest, how: plan.how });
      }
      if (added.length) {
        pending.set(petId, [...list, ...added]);
        stored.set(petId, total);
      }
      return { added, rejected };
    },

    /** 첨부 하나를 뺀다 (복사본도 지운다) @param {string} petId @param {string} id */
    async remove(petId, id) {
      const list = pending.get(petId) ?? [];
      const hit = list.find((f) => f.id === id);
      if (!hit) return;
      pending.set(petId, list.filter((f) => f !== hit));
      stored.set(petId, Math.max(0, (stored.get(petId) ?? 0) - hit.size));
      await fsp.rm(hit.path, { force: true }).catch(() => {});
    },

    /** 메시지를 보낼 때: 지금 붙어 있는 첨부를 꺼낸다 (입력창의 칩은 비워지지만 복사본은 이 대화가 끝날 때까지 남는다) @param {string} petId */
    takePending(petId) {
      const list = pending.get(petId) ?? [];
      pending.set(petId, []);
      return list;
    },

    /** 이 연결의 복사본을 모두 지운다 (대화가 끝났다) @param {string} petId */
    async clear(petId) {
      pending.delete(petId);
      stored.delete(petId);
      if (safeId(petId)) await fsp.rm(dirOf(petId), { recursive: true, force: true }).catch(() => {});
    },

    /** 모든 복사본을 지운다 (앱을 켤 때와 끌 때). 남은 것이 없어도 괜찮다 */
    clearAllSync() {
      pending.clear();
      stored.clear();
      try {
        fs.rmSync(root, { recursive: true, force: true });
      } catch {
        // 지우지 못해도 다음에 다시 시도한다
      }
    },
  };
}
