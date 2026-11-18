// @ts-check
import { net, protocol } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { doorFactor, resolveDoor } from '../shared/skinDoor.js';
import { applyTuning } from '../shared/skinTuning.js';
import { createSkinRoots, isInside, validateSkin } from './skinRoots.js';

export const SKIN_SCHEME = 'aipet-skin';
/** 문을 빌려 주는 기본 스킨 */
const DEFAULT_SKIN = 'default';

const here = path.dirname(fileURLToPath(import.meta.url));
const bundledRoot = path.resolve(here, '../../skins');

/** 번들 스킨 + (설정되면) 사용자 스킨 폴더 */
let roots = createSkinRoots({ bundled: bundledRoot });

/**
 * 사용자 스킨 폴더(userData/skins)를 등록한다. 앱 시작 시 한 번 호출한다.
 * @param {string} userDir
 */
export function configureSkinRoots(userDir) {
  roots = createSkinRoots({ bundled: bundledRoot, user: userDir });
}

/** 사용자 스킨 폴더 경로 (설정 전에는 null) */
export const userSkinsDir = () => roots.userDir;

/** 스킨의 시트 파일 경로 (트레이 아이콘용). 없는 스킨이면 null. @param {string} name @param {string} sheet */
export function skinSheetPath(name, sheet) {
  const found = roots.resolve(name);
  if (!found) return null;
  const file = path.resolve(found.dir, sheet);
  return isInside(found.dir, file) ? file : null;
}

/**
 * skin.json을 읽어 검증한 뒤 렌더러에 넘길 데이터를 반환한다.
 * 스킨은 데이터만 포함하며, 시트 경로는 스킨 폴더 내부로 제한한다.
 * @param {string} name
 * @param {import('../shared/skinTuning.js').Tuning | null} [tuning]  설정 창에서 입력한 프레임 크기/표시 높이
 */
export async function loadSkin(name, tuning) {
  const found = roots.resolve(name);
  if (!found) throw new Error(`스킨을 찾을 수 없어요: ${name}`);
  const dir = found.dir;
  if (found.source === 'user' && !roots.skinJsonSizeOk(dir)) throw new Error(`skin.json이 너무 커요: ${name}`);

  const raw = JSON.parse(await fs.readFile(path.join(dir, 'skin.json'), 'utf8'));
  if (!raw.animations?.idle) throw new Error('skin.json: idle 애니메이션은 필수입니다');
  // 사용자가 추가한 스킨은 외부에서 온 데이터이므로 값의 범위까지 검사한다.
  if (found.source === 'user') {
    const problem = validateSkin(raw);
    if (problem) throw new Error(`skin.json (${name}): ${problem}`);
  }

  for (const [state, anim] of Object.entries(raw.animations)) {
    const sheet = path.resolve(dir, String(anim.sheet));
    if (!isInside(dir, sheet)) throw new Error(`skin.json: '${state}' 시트 경로가 스킨 폴더를 벗어납니다`);
  }

  // 크기(scale)/앵커/히트박스는 사용자가 입력한 프레임 크기와 표시 높이에 맞춰 자동 환산한다.
  const t = applyTuning({ frameSize: raw.frameSize, scale: raw.scale ?? 1, anchor: raw.anchor, hitbox: raw.hitbox }, tuning);

  // 문(모니터 사이를 오갈 때): 이 스킨 폴더의 door 시트. 없으면 기본 스킨의 문을 빌려 쓰고, 그것도 없으면 렌더러가 코드로 그린다.
  // 문 크기는 이 펫이 화면에서 차지하는 높이에 맞춘다 (문 그림이 만들어진 펫 높이 대비 비율).
  let door = null;
  if (raw.door) {
    const sheet = path.resolve(dir, String(raw.door.sheet));
    if (!isInside(dir, sheet) || (raw.door.front && !isInside(dir, path.resolve(dir, String(raw.door.front))))) {
      throw new Error('skin.json: door 시트 경로가 스킨 폴더를 벗어납니다');
    }
    const factor = doorFactor({ petDisplayH: t.displaySize.h, ownerPetDisplayH: raw.frameSize.h * (raw.scale ?? 1), percent: tuning?.doorPercent });
    door = resolveDoor({ door: raw.door, owner: name, factor, pixelArt: raw.pixelArt ?? false });
  } else if (name !== DEFAULT_SKIN) {
    door = await borrowedDoor(t.displaySize.h, tuning?.doorPercent);
  }

  return {
    name,
    source: found.source,
    frameSize: t.frameSize,
    scale: t.scale,
    facing: raw.facing ?? 'left',
    flippable: raw.flippable ?? true,
    pixelArt: raw.pixelArt ?? false,
    fallbacks: raw.fallbacks ?? {},
    anchor: t.anchor,
    hitbox: t.hitbox,
    animations: raw.animations,
    door,
  };
}

/** 문이 없는 스킨이 빌려 쓰는 기본 스킨의 문 @param {number} petDisplayH 이 펫이 화면에서 차지하는 높이(px) @param {number} [percent] 문 크기(%) */
async function borrowedDoor(petDisplayH, percent) {
  try {
    const def = roots.resolve(DEFAULT_SKIN);
    if (!def || def.source !== 'bundled') return null; // 앱에 들어 있는 기본 스킨만 믿는다
    const raw = JSON.parse(await fs.readFile(path.join(def.dir, 'skin.json'), 'utf8'));
    if (!raw.door) return null;
    const factor = doorFactor({ petDisplayH, ownerPetDisplayH: raw.frameSize.h * (raw.scale ?? 1), percent });
    return resolveDoor({ door: raw.door, owner: DEFAULT_SKIN, factor, pixelArt: raw.pixelArt ?? false });
  } catch {
    return null; // 문 그림이 없어도 펫은 동작한다 (코드로 그린 문을 쓴다)
  }
}

/**
 * 설정 창이 문 크기를 미리 계산하는 데 필요한 값: 쓰게 될 문(자기 것, 없으면 기본 스킨의 것)의 프레임 크기와 배율,
 * 그 문이 만들어질 때의 펫 높이. 문이 아예 없으면 null.
 * @param {string} name @param {any} raw
 */
async function doorInfo(name, raw) {
  /** @param {any} r */
  const info = (r, /** @type {boolean} */ own) => ({
    own,
    frameSize: r.door.frameSize,
    scale: r.door.scale ?? 1,
    ownerPetDisplayH: r.frameSize.h * (r.scale ?? 1),
  });
  if (raw.door) return info(raw, true);
  if (name === DEFAULT_SKIN) return null;
  try {
    const def = roots.resolve(DEFAULT_SKIN);
    if (!def || def.source !== 'bundled') return null;
    const d = JSON.parse(await fs.readFile(path.join(def.dir, 'skin.json'), 'utf8'));
    return d.door ? info(d, false) : null;
  } catch {
    return null;
  }
}

/** PNG 헤더에서 크기를 읽는다. @param {string} file @returns {Promise<{ width: number, height: number } | null>} */
async function pngSize(file) {
  try {
    const fh = await fs.open(file, 'r');
    try {
      const b = Buffer.alloc(24);
      await fh.read(b, 0, 24, 0);
      if (b.toString('ascii', 1, 4) !== 'PNG') return null;
      return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
    } finally {
      await fh.close();
    }
  } catch {
    return null; // 없는 시트는 fallbacks로 대체되므로 오류가 아니다
  }
}

/**
 * 설정 창에 보여 줄 스킨 정보: skin.json의 원본 값과, 실제로 있는 시트의 이미지 크기.
 * @param {string} name
 */
export async function inspectSkin(name) {
  const found = roots.resolve(name);
  if (!found) return null;
  const dir = found.dir;
  try {
    const raw = JSON.parse(await fs.readFile(path.join(dir, 'skin.json'), 'utf8'));
    /** @type {{ anim: string, frames: number, width: number, height: number }[]} */
    const sheets = [];
    for (const [anim, a] of Object.entries(/** @type {Record<string, any>} */ (raw.animations))) {
      const file = path.resolve(dir, String(a.sheet));
      if (!isInside(dir, file)) continue;
      const size = await pngSize(file);
      if (size) sheets.push({ anim, frames: a.frames, ...size });
    }
    return {
      id: name,
      door: await doorInfo(name, raw),
      authored: {
        frameSize: raw.frameSize,
        scale: raw.scale ?? 1,
        anchor: raw.anchor,
        hitbox: raw.hitbox ?? { x: 0, y: 0, w: raw.frameSize.w, h: raw.frameSize.h },
      },
      sheets,
    };
  } catch {
    return null;
  }
}

/**
 * 설치된 스킨 목록 (번들 + 사용자 폴더의 skins/<폴더>/skin.json).
 * @returns {Promise<{ id: string, name: string, author: string, source: 'bundled' | 'user' }[]>}
 */
export async function listSkins() {
  const out = [];
  for (const { id, dir, source } of roots.list()) {
    try {
      if (source === 'user' && !roots.skinJsonSizeOk(dir)) continue;
      const raw = JSON.parse(await fs.readFile(path.join(dir, 'skin.json'), 'utf8'));
      if (source === 'user' && validateSkin(raw)) continue; // 형식이 잘못된 사용자 스킨은 목록에서 뺀다
      out.push({ id, name: String(raw.name ?? id).slice(0, 64), author: String(raw.author ?? '').slice(0, 64), source });
    } catch {
      // skin.json이 깨진 폴더는 목록에서 뺀다
    }
  }
  return out;
}

/** aipet-skin://<skin>/<file>.png 요청을 스킨 폴더(번들 또는 사용자) 안의 PNG로만 연결한다. */
export function registerSkinProtocol() {
  protocol.handle(SKIN_SCHEME, async (request) => {
    const url = new URL(request.url);
    const found = roots.resolve(url.hostname);
    if (!found) return new Response('Not found', { status: 404 });
    const file = path.resolve(found.dir, decodeURIComponent(url.pathname).replace(/^\/+/, ''));
    if (!isInside(found.dir, file) || path.extname(file).toLowerCase() !== '.png') {
      return new Response('Not found', { status: 404 });
    }
    if (!(await fs.stat(file).then((st) => st.isFile(), () => false))) {
      return new Response('Not found', { status: 404 }); // 에셋이 아직 없는 경우
    }
    return net.fetch(pathToFileURL(file).toString());
  });
}
