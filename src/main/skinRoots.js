// @ts-check
// 스킨 폴더 해석. 번들 스킨(앱 안)과 사용자 스킨(userData/skins)을 모두 찾는다. Electron에 의존하지 않는다.
//  - 같은 이름이면 번들 스킨이 우선한다 (사용자가 default 등을 덮어쓸 수 없다).
//  - 사용자 스킨은 신뢰할 수 없는 입력이므로 폴더 이름과 skin.json 값을 엄격히 검사한다.
import fs from 'node:fs';
import path from 'node:path';

/** 사용자 스킨 폴더 이름: aipet-skin://<이름>/ 의 호스트로 쓰이므로 ASCII 영숫자, -, _ 만 허용 */
export const USER_SKIN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

const MAX_SKIN_JSON_BYTES = 256 * 1024;
const SHEET_PATH = /^[A-Za-z0-9_./-]+\.png$/;
const STATE_NAME = /^[a-z][a-z0-9_]{0,31}$/;

/** @param {string} root @param {string} target */
export function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/** @param {unknown} v @param {number} min @param {number} max */
const isNum = (v, min, max) => typeof v === 'number' && Number.isFinite(v) && v >= min && v <= max;

/**
 * 사용자 스킨의 skin.json을 검사한다. 문제가 있으면 사유를, 괜찮으면 null을 반환한다.
 * @param {any} raw
 * @returns {string | null}
 */
export function validateSkin(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return 'skin.json이 객체가 아니에요';
  const fs_ = raw.frameSize;
  if (!fs_ || !isNum(fs_.w, 8, 2048) || !isNum(fs_.h, 8, 2048)) return 'frameSize.w/h는 8~2048 사이 숫자여야 해요';
  if (!raw.anchor || !isNum(raw.anchor.x, -4096, 4096) || !isNum(raw.anchor.y, -4096, 4096)) return 'anchor.x/y가 숫자여야 해요';
  if (raw.scale !== undefined && !isNum(raw.scale, 0.01, 16)) return 'scale은 0.01~16 사이여야 해요';
  const hb = raw.hitbox;
  if (hb !== undefined && !(hb && isNum(hb.x, -4096, 4096) && isNum(hb.y, -4096, 4096) && isNum(hb.w, 1, 4096) && isNum(hb.h, 1, 4096))) {
    return 'hitbox는 x, y, w, h 숫자여야 해요';
  }
  const anims = raw.animations;
  if (!anims || typeof anims !== 'object' || Array.isArray(anims)) return 'animations가 없어요';
  if (!anims.idle) return 'idle 애니메이션은 필수예요';
  const names = Object.keys(anims);
  if (names.length > 64) return '애니메이션이 너무 많아요 (최대 64개)';
  for (const name of names) {
    const a = anims[name];
    if (!STATE_NAME.test(name)) return `애니메이션 이름 형식이 맞지 않아요: ${name}`;
    if (!a || typeof a.sheet !== 'string' || !SHEET_PATH.test(a.sheet) || a.sheet.includes('..') || path.isAbsolute(a.sheet)) {
      return `'${name}'의 sheet는 스킨 폴더 안의 .png 상대 경로여야 해요`;
    }
    if (!Number.isInteger(a.frames) || a.frames < 1 || a.frames > 64) return `'${name}'의 frames는 1~64 정수여야 해요`;
    if (!isNum(a.fps, 0.1, 60)) return `'${name}'의 fps는 0.1~60 사이여야 해요`;
    if (a.next !== undefined && typeof a.next !== 'string') return `'${name}'의 next는 문자열이어야 해요`;
  }
  return null;
}

/**
 * @param {{ bundled: string, user?: string | null }} opts
 */
export function createSkinRoots({ bundled, user }) {
  /** @type {{ dir: string, source: 'bundled' | 'user' }[]} */
  const roots = [{ dir: bundled, source: 'bundled' }];
  if (user) roots.push({ dir: user, source: 'user' });

  /** 이름이 이 루트에서 쓸 수 있는 형식인가 @param {{ source: string }} r @param {string} name */
  const nameOk = (r, name) => name !== '' && (r.source === 'bundled' || USER_SKIN_ID.test(name));

  /**
   * 스킨 이름 → 폴더. 없거나 잘못된 이름이면 null.
   * @param {string} name
   * @returns {{ dir: string, source: 'bundled' | 'user' } | null}
   */
  function resolve(name) {
    if (typeof name !== 'string') return null;
    for (const r of roots) {
      if (!nameOk(r, name)) continue;
      const dir = path.resolve(r.dir, name);
      if (isInside(r.dir, dir) && fs.existsSync(path.join(dir, 'skin.json'))) return { dir, source: r.source };
    }
    // aipet-skin:// 의 호스트 이름은 소문자로 바뀌므로, 대소문자만 다른 폴더(대소문자를 구분하는 파일 시스템)도 찾는다.
    const lower = name.toLowerCase();
    const hit = list().find((s) => s.id.toLowerCase() === lower);
    return hit ? { dir: hit.dir, source: hit.source } : null;
  }

  /**
   * 설치된 스킨 폴더 목록 (번들 먼저, 같은 이름은 번들만).
   * @returns {{ id: string, dir: string, source: 'bundled' | 'user' }[]}
   */
  function list() {
    /** @type {{ id: string, dir: string, source: 'bundled' | 'user' }[]} */
    const out = [];
    const seen = new Set();
    for (const r of roots) {
      /** @type {fs.Dirent[]} */
      let entries;
      try {
        entries = fs.readdirSync(r.dir, { withFileTypes: true });
      } catch {
        continue; // 폴더가 아직 없으면 건너뜀
      }
      for (const e of entries) {
        if (!e.isDirectory() || !nameOk(r, e.name) || seen.has(e.name.toLowerCase())) continue;
        const dir = path.join(r.dir, e.name);
        if (!fs.existsSync(path.join(dir, 'skin.json'))) continue;
        seen.add(e.name.toLowerCase());
        out.push({ id: e.name, dir, source: r.source });
      }
    }
    return out;
  }

  /** skin.json 파일 크기가 한도 안인가 (사용자 스킨의 비정상적으로 큰 파일 방지) @param {string} dir */
  function skinJsonSizeOk(dir) {
    try {
      return fs.statSync(path.join(dir, 'skin.json')).size <= MAX_SKIN_JSON_BYTES;
    } catch {
      return false;
    }
  }

  return { resolve, list, skinJsonSizeOk, userDir: user ?? null };
}
