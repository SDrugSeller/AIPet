// @ts-check
// 말투(페르소나) 저장소. 말투 하나 = 텍스트 파일(.txt) 하나, 파일 이름이 말투 이름이다.
// 사용자 폴더(userData/personas)에 저장하며, 처음에는 저장소의 personas/ 폴더 내용을 복사해 채운다.
import fs from 'node:fs';
import path from 'node:path';

export const DEFAULT_PERSONA_ID = '기본.txt';
/** 말투 하나의 최대 길이 (시스템 프롬프트가 너무 길어지지 않게) */
export const MAX_PERSONA_CHARS = 4000;

/** 파일 이름으로 쓸 수 없는 문자 */
// eslint-disable-next-line no-control-regex
const INVALID_CHARS = /[\\/:*?"<>|\x00-\x1f]/;

/** 말투 ID(파일 이름)가 안전한가. 경로 조작(.., 폴더 구분자)을 막는다. @param {unknown} id */
export function isValidPersonaId(id) {
  return (
    typeof id === 'string' &&
    id.length > 4 &&
    id.length <= 64 &&
    id.endsWith('.txt') &&
    !INVALID_CHARS.test(id) &&
    !id.startsWith('.') &&
    !id.includes('..')
  );
}

/**
 * @param {{ dir: string, seedDir?: string }} opts
 */
export function createPersonaStore({ dir, seedDir }) {
  /** 폴더가 없거나 비어 있으면 기본 말투들을 복사한다. (사용자가 지운 말투가 되살아나지 않게, 비었을 때만) */
  function ensureSeeded() {
    fs.mkdirSync(dir, { recursive: true });
    if (fs.readdirSync(dir).some((f) => f.endsWith('.txt'))) return;
    if (!seedDir || !fs.existsSync(seedDir)) return;
    for (const f of fs.readdirSync(seedDir)) {
      if (isValidPersonaId(f)) fs.copyFileSync(path.join(seedDir, f), path.join(dir, f));
    }
  }

  ensureSeeded();

  const fileOf = (/** @type {string} */ id) => path.join(dir, id);

  return {
    dir,

    /** @returns {{ id: string, name: string }[]} */
    list() {
      try {
        return fs
          .readdirSync(dir)
          .filter(isValidPersonaId)
          .sort((a, b) => a.localeCompare(b, 'ko'))
          .map((id) => ({ id, name: id.slice(0, -4) }));
      } catch {
        return [];
      }
    },

    /** @param {string} id @returns {string | null} */
    read(id) {
      if (!isValidPersonaId(id)) return null;
      try {
        // 메모장으로 고치면 BOM이 붙으므로 떼어 낸다 (프롬프트에 보이지 않는 문자가 들어가지 않게)
        return fs.readFileSync(fileOf(id), 'utf8').replace(/^\uFEFF/, '').slice(0, MAX_PERSONA_CHARS);
      } catch {
        return null;
      }
    },

    /** 이미 있는 말투의 내용을 바꾼다. @param {string} id @param {string} text @returns {{ ok: boolean, reason?: string }} */
    write(id, text) {
      if (!isValidPersonaId(id) || !fs.existsSync(fileOf(id))) return { ok: false, reason: '없는 말투예요' };
      if (typeof text !== 'string') return { ok: false, reason: '내용이 올바르지 않아요' };
      fs.writeFileSync(fileOf(id), text.slice(0, MAX_PERSONA_CHARS), 'utf8');
      return { ok: true };
    },

    /** 새 말투를 만든다. 이름에 쓸 수 없는 문자는 지우고, 같은 이름이 있으면 번호를 붙인다. @param {string} name @param {string} text */
    create(name, text) {
      const clean = String(name ?? '')
        .replace(new RegExp(INVALID_CHARS, 'g'), '')
        .replace(/\.+$/g, '')
        .trim()
        .slice(0, 40);
      if (!clean) return { ok: false, reason: '이름을 입력해 주세요' };
      let id = `${clean}.txt`;
      for (let n = 2; fs.existsSync(fileOf(id)); n++) id = `${clean} ${n}.txt`;
      if (!isValidPersonaId(id)) return { ok: false, reason: '사용할 수 없는 이름이에요' };
      fs.writeFileSync(fileOf(id), String(text ?? '').slice(0, MAX_PERSONA_CHARS), 'utf8');
      return { ok: true, id };
    },

    /** @param {string} id @returns {{ ok: boolean, reason?: string }} */
    remove(id) {
      if (!isValidPersonaId(id) || !fs.existsSync(fileOf(id))) return { ok: false, reason: '없는 말투예요' };
      fs.unlinkSync(fileOf(id));
      return { ok: true };
    },
  };
}
