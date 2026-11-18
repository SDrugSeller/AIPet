// @ts-check
// genba가 이름에 들어간 스킨(저장소의 skins/*genba*/와 사용자 스킨 폴더의 *genba*/)에 쓸 회색 토관(土管) 한 장을
// 코드로 그려 각 스킨 폴더의 door.png로 저장하고, skin.json의 door 항목을 맞춘다.
// 현장냥이 그림체에 맞춘다: 얇은 검은 외곽선, 평평한 회색, 하얀 하이라이트, 도트(스크린톤) 음영.
// 토관은 옆으로 누운 원기둥을 왼쪽에서 비스듬히 본 모습이다.
//   - 가까운 쪽(왼쪽) 끝은 원(타원) 전체가 보이고 그 안에 어두운 구멍이 보인다.
//   - 먼 쪽(오른쪽) 끝은 원의 절반(바깥으로 볼록한 호)만 보인다. 그 끝의 면은 안 보인다.
//   - 몸통 표면의 이음매도 먼 쪽 끝과 같은 방향(오른쪽으로 볼록한 호)이다.
// 두 장으로 나눠 저장한다: door.png(전체, 펫 뒤)와 door-front.png(입구 가장자리 안쪽 몸통, 펫 앞).
// 펫이 입구로 걸어 들어가면 앞 그림이 몸을 가려 관 속으로 들어가는 것처럼 보인다.
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

// 옆으로 누운 토관: 바닥(발 위치 y=244)에 닿는다
const R = 92; // 원통 반지름(세로)
const CY = 244 - R; // 원통 가운데 높이
const RX = 40; // 끝면 타원의 가로 반지름 (옆에서 비스듬히 본 모습)
const X0 = 56; // 가까운 쪽(왼쪽) 끝면 중심 (그림이 좌우 가운데 x=128에 오도록 정했다. 좌우로 뒤집어도 자리가 같다)
const X1 = 200; // 먼 쪽(오른쪽) 끝면 중심
const SEAM_X = 126; // 몸통의 이음매 위치
const ENTER = 56; // 펫이 안으로 가려질 때까지 문 기준점에서 더 걸어가는 거리 (그림 픽셀)

const INK = [28, 28, 32];
const CONCRETE = [198, 198, 198];
const CONCRETE_DARK = [150, 150, 152];
const RIM = [222, 222, 222];
const WHITE = [248, 248, 248];
const HOLE = [44, 44, 50];
const HOLE_LIT = [86, 86, 94];

/** 타원의 부호 있는 거리 근사 (안쪽 < 0). 가로세로 비율이 커도 외곽선 굵기가 일정하다. */
const ellipse = (/** @type {number} */ cx, /** @type {number} */ cy, /** @type {number} */ rx, /** @type {number} */ ry) => (/** @type {number} */ x, /** @type {number} */ y) => {
  const px = x - cx;
  const py = y - cy;
  const k0 = Math.hypot(px / rx, py / ry);
  const k1 = Math.hypot(px / (rx * rx), py / (ry * ry));
  return k1 === 0 ? -Math.min(rx, ry) : (k0 * (k0 - 1)) / k1;
};
/** 사각형(가로 x0~x1, 세로 y0~y1)의 부호 있는 거리 */
const box = (/** @type {number} */ x0, /** @type {number} */ x1, /** @type {number} */ y0, /** @type {number} */ y1) => (/** @type {number} */ x, /** @type {number} */ y) => {
  const qx = Math.abs(x - (x0 + x1) / 2) - (x1 - x0) / 2;
  const qy = Math.abs(y - (y0 + y1) / 2) - (y1 - y0) / 2;
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0);
};

const body = box(X0, X1, CY - R, CY + R);
const capNear = ellipse(X0, CY, RX, R); // 가까운 쪽 끝면: 전체가 보인다
const capFar = ellipse(X1, CY, RX, R); // 먼 쪽 끝: 오른쪽 절반만 윤곽으로 보인다 (왼쪽 절반은 몸통에 가려짐)
/** 토관 전체 모양 (몸통 + 두 끝의 타원) */
const shape = (/** @type {number} */ x, /** @type {number} */ y) => Math.min(body(x, y), capNear(x, y), capFar(x, y));
const holeOuter = ellipse(X0 - 2, CY + 3, 29, 76);
const holeLight = ellipse(X0 - 10, CY - 7, 29, 76); // 이 타원 밖의 속 벽은 빛을 받아 밝다
const shadow = ellipse((X0 - RX + X1 + RX) / 2, 247, 112, 7);
/** 위쪽의 하얀 하이라이트 줄 */
const highlight = (/** @type {number} */ x, /** @type {number} */ y) => box(X0 + 42, X1 - 14, CY - R + 13, CY - R + 24)(x, y) - 5;

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
function sample(/** @type {number} */ x, /** @type {number} */ y, /** @type {boolean} */ front) {
  /** @type {number[]} */
  let col = [0, 0, 0, 0];
  if (!front && shadow(x, y) < 0) col = [0, 0, 0, 0.2]; // 바닥 그림자
  // 앞 레이어: 펫이 입구로 들어가면 가려지는 부분만. 가까운 쪽 끝면의 오른쪽 둘레(입구 가장자리)에서부터 몸통 쪽.
  // 끝면 안쪽(구멍과 테두리)은 펫 뒤에 그려서 펫이 입구 앞에서는 구멍 앞에 보인다.
  if (front && (x < X0 || capNear(x, y) < -1.4)) return col;
  const d = shape(x, y);
  if (d >= 2.4) return col;
  if (d >= 0) return [...INK, 1]; // 바깥 외곽선

  col = [...CONCRETE, 1];
  const dy = y - CY;

  // 아래쪽 음영: 도트(스크린톤)가 아래로 갈수록 커지다가 맨 아래는 꽉 찬 회색
  const t = (dy + 8) / (R + 8); // 0(가운데 약간 위) ~ 1(맨 아래)
  if (t > 0 && dot(x, y, Math.min(1, t * 1.25) * 3.6)) col = [...CONCRETE_DARK, 1];
  // 먼 쪽 끝(빛의 반대쪽)도 약간 어둡게
  if (x > X1 - 6 && t > -0.5 && dot(x, y, 2.2)) col = [...CONCRETE_DARK, 1];
  // 위쪽의 하얀 하이라이트
  if (highlight(x, y) < 0) col = [...WHITE, 1];

  // 이음매 한 줄: 몸통 표면을 따라 도는 고리의 보이는 쪽 절반. 먼 쪽 끝과 같은 방향(오른쪽으로 볼록)이다.
  const bulge = RX * Math.sqrt(Math.max(0, 1 - (dy / R) ** 2));
  if (Math.abs(x - (SEAM_X + bulge)) < 1.1 && Math.abs(dy) < R - 1) col = [...INK, 1];

  // 콘크리트 얼룩
  if (hash(Math.floor(x / 2), Math.floor(y / 2)) < 0.012) col = [120, 120, 124, 1];

  // 가까운 쪽 끝면: 두꺼운 테두리와 어두운 속. 타원 전체의 윤곽이 보인다.
  const face = capNear(x, y);
  if (face < 0) {
    col = [...RIM, 1];
    if (dy > R * 0.55) col = [...CONCRETE_DARK, 1]; // 테두리 아래쪽은 그늘
    const inner = holeOuter(x, y);
    if (inner < 0) {
      col = holeLight(x, y) < 0 ? [...HOLE, 1] : [...HOLE_LIT, 1];
      if (inner > -1.4) col = [...INK, 1];
    }
    if (face > -1.4) col = [...INK, 1]; // 끝면 둘레 선
  }
  return col;
}

/** 토관 그림을 RGBA 픽셀로 그린다. front면 펫보다 앞에 그릴 부분만 */
function render(/** @type {boolean} */ front) {
  const data = new Uint8Array(W * H * 4);
  for (let py = 0; py < H; py++) {
    for (let px = 0; px < W; px++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const c = sample(px + (sx + 0.5) / SS, py + (sy + 0.5) / SS, front);
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

const png = render(false);
const pngFront = render(true);
const target = process.argv[2];
if (target) {
  mkdirSync(path.dirname(path.resolve(target)), { recursive: true });
  writeFileSync(target, png);
  const frontTarget = target.replace(/(\.png)?$/i, '-front.png');
  writeFileSync(frontTarget, pngFront);
  console.log(`토관 ${W}x${H} → ${target}, ${frontTarget}`);
} else {
  const dirs = genbaSkinDirs();
  if (!dirs.length) console.log('genba가 들어간 스킨 폴더를 찾지 못했어요');
  for (const dir of dirs) {
    const file = path.join(dir, 'skin.json');
    const skin = JSON.parse(readFileSync(file, 'utf8'));
    // 문이 펫 키와 같은 높이로 보이게: 펫이 화면에서 차지하는 높이 ÷ 그림 높이
    const scale = Math.round(((skin.frameSize.h * (skin.scale ?? 1)) / H) * 10000) / 10000;
    skin.door = { sheet: 'door.png', frames: 1, frameSize: { w: W, h: H }, anchor: { x: (X0 - RX + X1 + RX) / 2, y: 244 }, scale, opening: 'left', front: 'door-front.png', enter: ENTER };
    writeFileSync(path.join(dir, 'door.png'), png);
    writeFileSync(path.join(dir, 'door-front.png'), pngFront);
    writeFileSync(file, `${JSON.stringify(skin, null, 2)}\n`);
    console.log(`${dir}  (문 배율 ${scale})`);
  }
}
