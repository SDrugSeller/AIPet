// @ts-check
// genba가 이름에 들어간 스킨(저장소의 skins/*genba*/와 사용자 스킨 폴더의 *genba*/)에 쓸 회색 토관(土管) 한 장을
// 코드로 그려 각 스킨 폴더의 door.png로 저장하고, skin.json의 door 항목을 맞춘다.
// 현장냥이 그림체에 맞춘다: 얇은 검은 외곽선, 평평한 회색, 하얀 하이라이트, 도트(스크린톤) 음영.
// 토관은 정면에서 본 모습이다: 출입부가 동그란 원으로 보이고, 몸통의 뒤쪽은 보이지 않는다(들어가는 느낌).
// 원본 이미지를 쓰지 않고 전부 도형으로 그린 그림이다. (skins/genba-cat/ 등 개인 스킨 폴더는 저장소에 포함되지 않는다)
//   사용법: node tools/genba/gen-pipe.mjs            → genba가 들어간 스킨 모두
//           node tools/genba/gen-pipe.mjs 출력.png   → 그림 한 장만 저장 (skin.json은 건드리지 않음)
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodePng } from '../pngEncode.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));

const W = 256;
const H = 256;
const SS = 3; // 한 픽셀을 SS×SS로 나누어 그린 뒤 평균을 낸다 (가장자리를 부드럽게)

// 정면에서 본 토관: 바닥(발 위치 y=244)에 닿는 큰 원
const R = 92; // 바깥 원 반지름
const CX = 128;
const CY = 244 - R;
const R_BEVEL = 80; // 바깥 테두리와 안쪽 단면의 경계
const R_HOLE = 66; // 뚫린 구멍

const INK = [28, 28, 32];
const CONCRETE = [198, 198, 198];
const CONCRETE_DARK = [150, 150, 152];
const RIM = [222, 222, 222];
const WHITE = [248, 248, 248];
const HOLE = [40, 40, 46];
const HOLE_LIT = [82, 82, 90];

const dist = (/** @type {number} */ x, /** @type {number} */ y, /** @type {number} */ cx = CX, /** @type {number} */ cy = CY) => Math.hypot(x - cx, y - cy);
const shadow = (/** @type {number} */ x, /** @type {number} */ y) => Math.hypot((x - CX) / 80, (y - 247) / 7) - 1;

/** 같은 입력에는 항상 같은 값(0~1)을 주는 작은 해시: 콘크리트 얼룩용 */
const hash = (/** @type {number} */ a, /** @type {number} */ b) => {
  let h = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

/** 45도로 기울어진 도트 격자: 한 점이 도트 안이면 true. size는 도트 반지름 */
function dot(/** @type {number} */ x, /** @type {number} */ y, /** @type {number} */ size) {
  const u = (x + y) / Math.SQRT2;
  const v = (x - y) / Math.SQRT2;
  return Math.hypot(u - Math.floor(u / 6) * 6 - 3, v - Math.floor(v / 6) * 6 - 3) < size;
}

/** 한 점의 색 [r, g, b, a(0~1)] */
function sample(/** @type {number} */ x, /** @type {number} */ y) {
  /** @type {number[]} */
  let col = [0, 0, 0, 0];
  if (shadow(x, y) < 0) col = [0, 0, 0, 0.2]; // 바닥 그림자
  const r = dist(x, y);
  if (r >= R + 2.4) return col;
  if (r >= R) return [...INK, 1]; // 바깥 외곽선

  const dx = x - CX;
  const dy = y - CY;
  // 오른쪽 아래로 갈수록 0→1: 빛은 왼쪽 위에서 온다
  const lit = (dx + dy) / Math.SQRT2 / R;

  if (r >= R_HOLE) {
    // 테두리: 바깥 고리는 콘크리트색, 안쪽 단면(경사면)은 더 밝은 색
    col = r >= R_BEVEL ? [...CONCRETE, 1] : [...RIM, 1];
    // 오른쪽 아래 음영: 도트가 커지다가 가장자리는 꽉 찬 회색
    if (lit > 0.05 && dot(x, y, Math.min(1, (lit - 0.05) * 1.6) * 3.6)) col = [...CONCRETE_DARK, 1];
    // 왼쪽 위의 하얀 하이라이트 (바깥 고리를 따라 휜 호)
    const deg = (Math.atan2(dy, dx) * 180) / Math.PI;
    if (deg < -112 && deg > -168 && r > R_BEVEL + 3 && r < R - 4) col = [...WHITE, 1];
    // 바깥 고리와 단면의 경계선
    if (Math.abs(r - R_BEVEL) < 1.1) col = [...INK, 1];
    // 콘크리트 얼룩
    if (hash(Math.floor(x / 2), Math.floor(y / 2)) < 0.012) col = [120, 120, 124, 1];
    // 구멍 가장자리 선
    if (r < R_HOLE + 1.5) col = [...INK, 1];
    return col;
  }

  // 구멍: 깊고 어둡다. 뒤쪽은 보이지 않고, 빛을 받은 안쪽 벽만 오른쪽 아래에 초승달로 보인다.
  col = dist(x, y, CX - 9, CY - 9) > R_HOLE - 1 && lit > 0 ? [...HOLE_LIT, 1] : [...HOLE, 1];
  return col;
}

/** 토관 그림을 RGBA 픽셀로 그린다 */
function render() {
  const data = new Uint8Array(W * H * 4);
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = sample(px + (sx + 0.5) / SS, py + (sy + 0.5) / SS);
          r += c[0] * c[3];
          g += c[1] * c[3];
          b += c[2] * c[3];
          a += c[3];
        }
      }
      const i = (py * W + px) * 4;
      if (a > 0) {
        data[i] = Math.round(r / a);
        data[i + 1] = Math.round(g / a);
        data[i + 2] = Math.round(b / a);
        data[i + 3] = Math.round((a / (SS * SS)) * 255);
      }
    }
  }
  return encodePng({ w: W, h: H, data });
}

/** 이름에 genba가 들어간 스킨 폴더들: 저장소의 skins와 사용자 스킨 폴더(%APPDATA%/AIPet/skins) */
function genbaSkinDirs() {
  const roots = [path.resolve(here, '../../skins')];
  const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
  roots.push(path.join(appData, 'AIPet', 'skins'));
  /** @type {string[]} */
  const out = [];
  const seen = new Set();
  for (const root of roots) {
    if (!existsSync(root)) continue;
    for (const e of readdirSync(root, { withFileTypes: true })) {
      const dir = path.join(root, e.name);
      if (!e.isDirectory() || !/genba/i.test(e.name) || !existsSync(path.join(dir, 'skin.json'))) continue;
      const key = path.resolve(dir).toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(dir);
    }
  }
  return out;
}

const png = render();
const target = process.argv[2];
if (target) {
  mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
  writeFileSync(target, png);
  console.log(`토관 ${W}x${H} → ${target}`);
} else {
  const dirs = genbaSkinDirs();
  if (!dirs.length) console.log('genba가 들어간 스킨 폴더를 찾지 못했어요');
  for (const dir of dirs) {
    const file = path.join(dir, 'skin.json');
    const skin = JSON.parse(readFileSync(file, 'utf8'));
    // 문이 펫 키와 같은 높이로 보이게: 펫이 화면에서 차지하는 높이 ÷ 그림 높이
    const scale = Math.round(((skin.frameSize.h * (skin.scale ?? 1)) / H) * 10000) / 10000;
    skin.door = { sheet: 'door.png', frames: 1, frameSize: { w: W, h: H }, anchor: { x: CX, y: 244 }, scale };
    writeFileSync(path.join(dir, 'door.png'), png);
    writeFileSync(file, `${JSON.stringify(skin, null, 2)}\n`);
    console.log(`${dir}  (문 배율 ${scale})`);
  }
}
