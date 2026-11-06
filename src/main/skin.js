// @ts-check
import { net, protocol } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { applyTuning } from '../shared/skinTuning.js';
import { createSkinRoots, isInside, validateSkin } from './skinRoots.js';

export const SKIN_SCHEME = 'aipet-skin';

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
  };
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
