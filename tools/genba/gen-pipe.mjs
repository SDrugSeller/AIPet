// @ts-check
// genba-cat 스킨용 회색 토관(土管) 한 장을 코드로 그려 skins/genba-cat/door.png로 저장한다.
// 현장냥이 그림체에 맞춘다: 얇은 검은 외곽선, 평평한 회색, 하얀 하이라이트, 도트(스크린톤) 음영.
// 원본 이미지를 쓰지 않고 전부 도형으로 그린 그림이다. (skins/genba-cat/은 저장소에 포함되지 않는다)
//   사용법: node tools/genba/gen-pipe.mjs [출력 경로]
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { encodePng } from '../pngEncode.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = process.argv[2] ?? path.resolve(here, '../../skins/genba-cat/door.png');

const W = 256;
const H = 256;
const SS = 3; // 한 픽셀을 SS×SS로 나누어 그린 뒤 평균을 낸다 (가장자리를 부드럽게)

/** 토관: 옆으로 누운 원통. 왼쪽 끝이 뚫려 있고 어두운 속이 보인다. 바닥 끝(발 위치)은 y=244, 가운데 x=128 */
const R = 92; // 원통 반지름(세로). 화면에서 고양이 키(약 106px)에 가깝게
const CY = 244 - R; // 원통 가운데 높이
const RX = 40; // 끝면 타원의 가로 반지름 (옆에서 비스듬히 본 모습)
const X0 = 58; // 왼쪽 끝면 중심
const X1 = 202; // 오른쪽 끝면 중심

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
const capL = ellipse(X0, CY, RX, R);
const capR = ellipse(X1, CY, RX, R);
const shape = (/** @type {number} */ x, /** @type {number} */ y) => Math.min(body(x, y), capL(x, y), capR(x, y));
const holeOuter = ellipse(X0 - 2, CY + 3, 29, 76);
const holeLight = ellipse(X0 - 10, CY - 7, 29, 76); // 이 타원 밖의 속 벽은 빛을 받아 밝다
const shadow = ellipse(W / 2, 247, 112, 7);
const highlight = (/** @type {number} */ x, /** @type {number} */ y) => box(X0 + 42, X1 - 14, CY - R + 13, CY - R + 24)(x, y) - 5; // 위쪽의 하얀 줄
const SEAM_X = 152;

/** 같은 입력에는 항상 같은 값(0~1)을 주는 작은 해시: 콘크리트 얼룩용 */
const hash = (/** @type {number} */ a, /** @type {number} */ b) => {
  let h = Math.imul(a | 0, 374761393) ^ Math.imul(b | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
};

/** 한 점의 색 [r, g, b, a(0~1)] */
function sample(/** @type {number} */ x, /** @type {number} */ y) {
  /** @type {number[]} */
  let col = [0, 0, 0, 0];
  if (shadow(x, y) < 0) col = [0, 0, 0, 0.2]; // 바닥 그림자
  const d = shape(x, y);
  if (d >= 2.4) return col;
  if (d >= 0) return [...INK, 1]; // 바깥 외곽선

  col = [...CONCRETE, 1];
  const dy = y - CY;

  // 아래쪽 음영: 도트(스크린톤)가 아래로 갈수록 커지다가 맨 아래는 꽉 찬 회색
  const t = (dy + 8) / (R + 8); // 0(가운데 약간 위) ~ 1(맨 아래)
  if (t > 0) {
    const u = (x + y) / Math.SQRT2;
    const v = (x - y) / Math.SQRT2;
    const gx = u - Math.floor(u / 6) * 6 - 3;
    const gy = v - Math.floor(v / 6) * 6 - 3;
    if (Math.hypot(gx, gy) < Math.min(1, t * 1.25) * 3.6) col = [...CONCRETE_DARK, 1];
  }
  // 오른쪽 끝(빛의 반대쪽)도 약간 어둡게
  if (x > X1 - 8 && t > -0.5) {
    const u = (x + y) / Math.SQRT2;
    const v = (x - y) / Math.SQRT2;
    if (Math.hypot(u - Math.floor(u / 6) * 6 - 3, v - Math.floor(v / 6) * 6 - 3) < 2.2) col = [...CONCRETE_DARK, 1];
  }
  // 위쪽의 하얀 하이라이트
  if (highlight(x, y) < 0) col = [...WHITE, 1];

  // 이음매 한 줄: 원통 표면을 따라 둥글게 휜 선
  const bulge = RX * Math.sqrt(Math.max(0, 1 - (dy / R) ** 2));
  if (Math.abs(x - (SEAM_X - bulge)) < 1.1 && Math.abs(dy) < R - 1) col = [...INK, 1];

  // 콘크리트 얼룩
  if (hash(Math.floor(x / 2), Math.floor(y / 2)) < 0.012) col = [120, 120, 124, 1];

  // 왼쪽 끝면: 두꺼운 테두리와 어두운 속
  const rim = capL(x, y);
  if (rim < 0) {
    col = [...RIM, 1];
    if (dy > R * 0.55) col = [...CONCRETE_DARK, 1]; // 테두리 아래쪽은 그늘
    const inner = holeOuter(x, y);
    if (inner < 0) {
      col = holeLight(x, y) < 0 ? [...HOLE, 1] : [...HOLE_LIT, 1];
      if (inner > -1.4) col = [...INK, 1];
    }
    if (rim > -1.4) col = [...INK, 1]; // 끝면 둘레 선
  }
  return col;
}

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

mkdirSync(path.dirname(out), { recursive: true });
writeFileSync(out, encodePng({ w: W, h: H, data }));
console.log(`토관 ${W}x${H} → ${out}`);
