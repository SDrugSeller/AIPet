// @ts-check
import { net, protocol } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { applyTuning } from '../shared/skinTuning.js';

export const SKIN_SCHEME = 'aipet-skin';

const here = path.dirname(fileURLToPath(import.meta.url));
const skinsRoot = path.resolve(here, '../../skins');

/** @param {string} root @param {string} target */
function isInside(root, target) {
  const rel = path.relative(root, target);
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

/**
 * skin.json을 읽어 검증한 뒤 렌더러에 넘길 데이터를 반환한다.
 * 스킨은 데이터만 포함하며, 시트 경로는 스킨 폴더 내부로 제한한다.
 * @param {string} name
 * @param {import('../shared/skinTuning.js').Tuning | null} [tuning]  설정 창에서 입력한 프레임 크기/표시 높이
 */
export async function loadSkin(name, tuning) {
  const dir = path.resolve(skinsRoot, name);
  if (!isInside(skinsRoot, dir)) throw new Error(`잘못된 스킨 이름: ${name}`);

  const raw = JSON.parse(await fs.readFile(path.join(dir, 'skin.json'), 'utf8'));
  if (!raw.animations?.idle) throw new Error('skin.json: idle 애니메이션은 필수입니다');

  for (const [state, anim] of Object.entries(raw.animations)) {
    const sheet = path.resolve(dir, String(anim.sheet));
    if (!isInside(dir, sheet)) throw new Error(`skin.json: '${state}' 시트 경로가 스킨 폴더를 벗어납니다`);
  }

  // 크기(scale)/앵커/히트박스는 사용자가 입력한 프레임 크기와 표시 높이에 맞춰 자동 환산한다.
  const t = applyTuning({ frameSize: raw.frameSize, scale: raw.scale ?? 1, anchor: raw.anchor, hitbox: raw.hitbox }, tuning);

  return {
    name,
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
  const dir = path.resolve(skinsRoot, name);
  if (!isInside(skinsRoot, dir)) return null;
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
 * 설치된 스킨 목록 (skins/<폴더>/skin.json 이 있는 폴더).
 * @returns {Promise<{ id: string, name: string, author: string }[]>}
 */
export async function listSkins() {
  const out = [];
  for (const entry of await fs.readdir(skinsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const raw = JSON.parse(await fs.readFile(path.join(skinsRoot, entry.name, 'skin.json'), 'utf8'));
      out.push({ id: entry.name, name: String(raw.name ?? entry.name), author: String(raw.author ?? '') });
    } catch {
      // skin.json이 없거나 깨진 폴더는 목록에서 뺀다
    }
  }
  return out;
}

/** aipet-skin://<skin>/<file>.png 요청을 skins/ 폴더 안의 파일로만 연결한다. */
export function registerSkinProtocol() {
  protocol.handle(SKIN_SCHEME, async (request) => {
    const url = new URL(request.url);
    const skinDir = path.resolve(skinsRoot, url.hostname);
    const file = path.resolve(skinDir, decodeURIComponent(url.pathname).replace(/^\/+/, ''));
    if (!isInside(skinsRoot, skinDir) || !isInside(skinDir, file) || path.extname(file) !== '.png') {
      return new Response('Not found', { status: 404 });
    }
    if (!(await fs.stat(file).then((s) => s.isFile(), () => false))) {
      return new Response('Not found', { status: 404 }); // 에셋이 아직 없는 경우
    }
    return net.fetch(pathToFileURL(file).toString());
  });
}
