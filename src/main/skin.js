// @ts-check
import { net, protocol } from 'electron';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

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
 */
export async function loadSkin(name) {
  const dir = path.resolve(skinsRoot, name);
  if (!isInside(skinsRoot, dir)) throw new Error(`잘못된 스킨 이름: ${name}`);

  const raw = JSON.parse(await fs.readFile(path.join(dir, 'skin.json'), 'utf8'));
  if (!raw.animations?.idle) throw new Error('skin.json: idle 애니메이션은 필수입니다');

  for (const [state, anim] of Object.entries(raw.animations)) {
    const sheet = path.resolve(dir, String(anim.sheet));
    if (!isInside(dir, sheet)) throw new Error(`skin.json: '${state}' 시트 경로가 스킨 폴더를 벗어납니다`);
  }

  return {
    name,
    frameSize: raw.frameSize,
    scale: raw.scale ?? 1,
    facing: raw.facing ?? 'left',
    flippable: raw.flippable ?? true,
    pixelArt: raw.pixelArt ?? false,
    fallbacks: raw.fallbacks ?? {},
    anchor: raw.anchor,
    hitbox: raw.hitbox ?? { x: 0, y: 0, w: raw.frameSize.w, h: raw.frameSize.h },
    animations: raw.animations,
  };
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
