// @ts-check
// skins/default 용 임시 스프라이트 시트(idle/walk/drag/drop/sleep)를 생성한다.
// 실제 아트가 준비되면 같은 파일명의 PNG로 교체하면 된다.
//   사용법: node tools/gen-placeholder-skin.mjs
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import zlib from 'node:zlib';

const here = path.dirname(fileURLToPath(import.meta.url));
const outDir = path.resolve(here, '../skins/default');
const FW = 128;
const FH = 128;
const CX = 64; // 몸 중심 x (anchor.x)
const FOOT = 124; // 발 위치 y (anchor.y)

const BODY = [255, 181, 133];
const BODY_DARK = [232, 150, 105];
const BELLY = [255, 215, 186];
const INK = [34, 34, 34];
const CHEEK = [255, 140, 140];
const ZZZ = [120, 150, 255];

/** @typedef {{ w: number, h: number, data: Uint8Array }} Img */

/** @param {number} w @param {number} h @returns {Img} */
const makeImg = (w, h) => ({ w, h, data: new Uint8Array(w * h * 4) });

/** 안티앨리어싱된 도형 채우기. sdf(x, y) < 0 이면 안쪽 (px 단위 거리) */
/** @param {Img} img @param {number[]} color @param {(x:number,y:number)=>number} sdf @param {number} ox @param {number} oy @param {number} [alpha] */
function fill(img, color, sdf, ox, oy, alpha = 1) {
  for (let y = 0; y < FH; y++) {
    for (let x = 0; x < FW; x++) {
      const a = Math.min(1, Math.max(0, 0.5 - sdf(x + 0.5, y + 0.5))) * alpha;
      if (a <= 0) continue;
      const i = ((y + oy) * img.w + (x + ox)) * 4;
      const da = img.data[i + 3] / 255;
      const oa = a + da * (1 - a);
      for (let c = 0; c < 3; c++) {
        img.data[i + c] = Math.round((color[c] * a + img.data[i + c] * da * (1 - a)) / oa);
      }
      img.data[i + 3] = Math.round(oa * 255);
    }
  }
}

const ellipse = (/** @type {number} */ cx, /** @type {number} */ cy, /** @type {number} */ rx, /** @type {number} */ ry) => (/** @type {number} */ x, /** @type {number} */ y) =>
  (Math.hypot((x - cx) / rx, (y - cy) / ry) - 1) * Math.min(rx, ry);

const roundRect = (/** @type {number} */ cx, /** @type {number} */ cy, /** @type {number} */ hw, /** @type {number} */ hh, /** @type {number} */ r) => (/** @type {number} */ x, /** @type {number} */ y) => {
  const qx = Math.abs(x - cx) - (hw - r);
  const qy = Math.abs(y - cy) - (hh - r);
  return Math.hypot(Math.max(qx, 0), Math.max(qy, 0)) + Math.min(Math.max(qx, qy), 0) - r;
};

const capsule = (/** @type {number} */ x1, /** @type {number} */ y1, /** @type {number} */ x2, /** @type {number} */ y2, /** @type {number} */ r) => (/** @type {number} */ x, /** @type {number} */ y) => {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const t = Math.min(1, Math.max(0, ((x - x1) * dx + (y - y1) * dy) / (dx * dx + dy * dy || 1)));
  return Math.hypot(x - (x1 + t * dx), y - (y1 + t * dy)) - r;
};

/**
 * 펫 한 프레임을 그린다. 왼쪽을 바라보는 콩 모양 캐릭터.
 * @param {Img} img @param {number} ox 시트 안의 프레임 x 오프셋
 * @param {{ sx?: number, sy?: number, lift?: number, sway?: number, footL?: number, footR?: number,
 *   eyes?: 'open' | 'blink' | 'closed' | 'wide' | 'up' | 'happy' | 'x',
 *   mouth?: 'none' | 'o' | 'smile' | 'frown', mouthOpen?: number }} p
 */
function drawPet(img, ox, p) {
  const { sx = 1, sy = 1, lift = 0, sway = 0, footL = 0, footR = 0, eyes = 'open', mouth = 'smile', mouthOpen = 0 } = p;
  const hw = 40 * sx;
  const hh = 50 * sy;
  const bottom = FOOT - 6 - lift; // 몸통 바닥 (발은 그 아래)
  const cy = bottom - hh;
  const cx = CX + sway;

  // 발
  fill(img, BODY_DARK, ellipse(cx - 16, FOOT - 3 - footL - lift * 0.3, 11, 5), ox, 0);
  fill(img, BODY_DARK, ellipse(cx + 12, FOOT - 3 - footR - lift * 0.3, 11, 5), ox, 0);
  // 몸통 + 배
  fill(img, BODY, roundRect(cx, cy, hw, hh, Math.min(hw, hh) * 0.85), ox, 0);
  fill(img, BELLY, ellipse(cx - 6, cy + hh * 0.35, hw * 0.55, hh * 0.45), ox, 0);

  // 얼굴 (왼쪽을 향해 살짝 치우침)
  const ey = cy - hh * 0.2;
  const ex = [cx - 22, cx - 2];
  for (const x of ex) {
    if (eyes === 'open') fill(img, INK, ellipse(x, ey, 4.5, 5.5), ox, 0);
    if (eyes === 'wide') fill(img, INK, ellipse(x, ey, 6, 7.5), ox, 0);
    if (eyes === 'blink') fill(img, INK, capsule(x - 4, ey, x + 4, ey, 1.4), ox, 0);
    if (eyes === 'up') {
      fill(img, INK, ellipse(x, ey - 3, 4.5, 5.5), ox, 0);
      fill(img, [255, 255, 255], ellipse(x - 1.2, ey - 5, 1.5, 1.5), ox, 0);
    }
    if (eyes === 'happy') {
      fill(img, INK, capsule(x - 4.5, ey + 1.5, x, ey - 2, 1.4), ox, 0);
      fill(img, INK, capsule(x, ey - 2, x + 4.5, ey + 1.5, 1.4), ox, 0);
    }
    if (eyes === 'x') {
      fill(img, INK, capsule(x - 4, ey - 4, x + 4, ey + 4, 1.4), ox, 0);
      fill(img, INK, capsule(x - 4, ey + 4, x + 4, ey - 4, 1.4), ox, 0);
    }
    if (eyes === 'closed') {
      fill(img, INK, capsule(x - 4.5, ey - 1.5, x, ey + 1.5, 1.3), ox, 0);
      fill(img, INK, capsule(x, ey + 1.5, x + 4.5, ey - 1.5, 1.3), ox, 0);
    }
    if (eyes === 'open' || eyes === 'wide') fill(img, [255, 255, 255], ellipse(x - 1.2, ey - 1.8, 1.5, 1.5), ox, 0);
  }
  fill(img, CHEEK, ellipse(cx - 32, ey + 10, 6, 3.5), ox, 0, 0.7);
  fill(img, CHEEK, ellipse(cx + 9, ey + 10, 6, 3.5), ox, 0, 0.7);
  const my = ey + 11;
  if (mouth === 'smile' && mouthOpen === 0) {
    fill(img, INK, capsule(cx - 15, my, cx - 11, my + 2, 1.1), ox, 0);
    fill(img, INK, capsule(cx - 11, my + 2, cx - 7, my, 1.1), ox, 0);
  }
  if (mouth === 'o') fill(img, INK, ellipse(cx - 11, my + 2, 3, 4), ox, 0);
  if (mouth === 'frown') {
    fill(img, INK, capsule(cx - 15, my + 3, cx - 11, my, 1.1), ox, 0);
    fill(img, INK, capsule(cx - 11, my, cx - 7, my + 3, 1.1), ox, 0);
  }
  if (mouthOpen > 0) fill(img, INK, ellipse(cx - 11, my + 2, 3 + mouthOpen * 1.5, 1.5 + mouthOpen * 4), ox, 0);
}

/** 잠자는 "Z" 글자 @param {Img} img @param {number} ox @param {number} x @param {number} y @param {number} s @param {number} alpha */
function drawZ(img, ox, x, y, s, alpha) {
  fill(img, ZZZ, capsule(x, y, x + s, y, 1.5), ox, 0, alpha);
  fill(img, ZZZ, capsule(x + s, y, x, y + s, 1.5), ox, 0, alpha);
  fill(img, ZZZ, capsule(x, y + s, x + s, y + s, 1.5), ox, 0, alpha);
}

/** 머리 위 느낌표 */
/** @param {Img} img @param {number} ox @param {number} x @param {number} y */
function drawExclaim(img, ox, x, y) {
  const red = [255, 80, 80];
  fill(img, red, capsule(x, y, x, y + 12, 2.2), ox, 0);
  fill(img, red, ellipse(x, y + 19, 2.4, 2.4), ox, 0);
}

/** 반짝이 (십자) @param {Img} img @param {number} ox @param {number} x @param {number} y @param {number} s @param {number} alpha */
function drawSparkle(img, ox, x, y, s, alpha) {
  const gold = [255, 214, 90];
  fill(img, gold, capsule(x - s, y, x + s, y, 1.3), ox, 0, alpha);
  fill(img, gold, capsule(x, y - s, x, y + s, 1.3), ox, 0, alpha);
}

/** 땀방울 @param {Img} img @param {number} ox @param {number} x @param {number} y */
function drawSweat(img, ox, x, y) {
  fill(img, [120, 190, 255], ellipse(x, y, 2.6, 4), ox, 0, 0.9);
}

const tau = Math.PI * 2;

/** @type {Record<string, { frames: number, draw: (img: Img, ox: number, i: number, n: number) => void }>} */
const sheets = {
  idle: {
    frames: 6,
    draw: (img, ox, i, n) => {
      const b = Math.sin((i / n) * tau);
      drawPet(img, ox, { sy: 1 + 0.03 * b, sx: 1 - 0.02 * b, eyes: i === 4 ? 'blink' : 'open' });
    },
  },
  walk: {
    frames: 8,
    draw: (img, ox, i, n) => {
      const s = Math.sin((i / n) * tau);
      drawPet(img, ox, {
        lift: Math.abs(Math.sin((i / n) * Math.PI * 2)) * 3,
        sway: s * 1.5,
        footL: Math.max(0, s) * 9,
        footR: Math.max(0, -s) * 9,
        sy: 1 - 0.015 * Math.abs(s),
      });
    },
  },
  drag: {
    frames: 3,
    draw: (img, ox, i) => {
      drawPet(img, ox, { sy: 1.1, sx: 0.93, sway: [-2, 0, 2][i], footL: 5 - i, footR: 3 + i, eyes: 'wide', mouth: 'o' });
    },
  },
  drop: {
    frames: 4,
    draw: (img, ox, i) => {
      drawPet(img, ox, { sy: [0.84, 0.8, 0.92, 1][i], sx: [1.12, 1.18, 1.06, 1][i], eyes: i < 2 ? 'blink' : 'open' });
    },
  },
  think: {
    frames: 6,
    draw: (img, ox, i, n) => {
      const b = Math.sin((i / n) * tau);
      drawPet(img, ox, { sy: 1 + 0.02 * b, eyes: 'up', mouth: 'none', sway: -1 });
      // 머리 위 "..." 이 하나씩 늘어난다
      const dots = 1 + (i % 3);
      for (let d = 0; d < dots; d++) fill(img, [150, 150, 160], ellipse(CX - 4 + d * 11, 16, 3, 3), ox, 0);
    },
  },
  work: {
    frames: 8,
    draw: (img, ox, i) => {
      const j = i % 2 ? 1.6 : -1.6;
      drawPet(img, ox, { sway: j, lift: i % 4 < 2 ? 1 : 0, sy: 0.98, eyes: 'blink', mouth: 'none' });
      drawSweat(img, ox, CX + 30, 28 + ((i * 3) % 10));
      drawSparkle(img, ox, CX - 36 + (i % 4) * 4, 30 + (i % 3) * 6, 3 + (i % 2), 0.9);
    },
  },
  talk: {
    frames: 4,
    draw: (img, ox, i, n) => {
      const open = [0.2, 1, 0.5, 0.9][i];
      drawPet(img, ox, { sy: 1 + 0.015 * Math.sin((i / n) * tau), mouthOpen: open });
    },
  },
  done: {
    frames: 8,
    draw: (img, ox, i, n) => {
      const hop = Math.sin((i / (n - 1)) * Math.PI);
      drawPet(img, ox, { lift: hop * 10, sy: 1 + 0.03 * hop, sx: 1 - 0.03 * hop, eyes: 'happy', footL: hop * 4, footR: hop * 4 });
      if (i >= 2) {
        drawSparkle(img, ox, CX - 44, 26 + (i % 3) * 5, 4, 0.9);
        drawSparkle(img, ox, CX + 40, 34 - (i % 2) * 6, 5, 0.9);
      }
    },
  },
  error: {
    frames: 6,
    draw: (img, ox, i) => {
      drawPet(img, ox, { sx: 1.03, sy: 0.94, sway: Math.sin(i * 2.4) * (4 - i * 0.5), eyes: 'x', mouth: 'frown' });
      drawSweat(img, ox, CX + 30, 30 + (i % 3) * 3);
    },
  },
  attention: {
    frames: 6,
    draw: (img, ox, i, n) => {
      const hop = Math.abs(Math.sin((i / n) * Math.PI));
      drawPet(img, ox, { lift: hop * 8, eyes: 'wide', mouth: 'o' });
      drawExclaim(img, ox, CX - 8, 2 + (1 - hop) * 3);
    },
  },
  sleep: {
    frames: 4,
    draw: (img, ox, i, n) => {
      const b = Math.sin((i / n) * tau);
      drawPet(img, ox, { sy: 0.92 + 0.03 * b, sx: 1.04 - 0.02 * b, eyes: 'closed', mouth: 'none' });
      const rise = (i / n) * 12;
      drawZ(img, ox, CX + 22, 38 - rise, 9, 1 - i / (n + 1));
      drawZ(img, ox, CX + 36, 24 - rise * 0.6, 6, 0.5 + 0.5 * (i / n));
    },
  },
};

// --- PNG 인코더 (외부 의존성 없음) ---

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
/** @param {Buffer} buf */
function crc32(buf) {
  let c = 0xffffffff;
  for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
/** @param {string} type @param {Buffer} data */
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
/** @param {Img} img */
function encodePng(img) {
  const stride = img.w * 4;
  const raw = Buffer.alloc((stride + 1) * img.h);
  for (let y = 0; y < img.h; y++) {
    raw[y * (stride + 1)] = 0;
    Buffer.from(img.data.buffer, y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(img.w, 0);
  ihdr.writeUInt32BE(img.h, 4);
  ihdr[8] = 8; // 비트 깊이
  ihdr[9] = 6; // RGBA
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

mkdirSync(outDir, { recursive: true });
for (const [name, { frames, draw }] of Object.entries(sheets)) {
  const img = makeImg(FW * frames, FH);
  for (let i = 0; i < frames; i++) draw(img, i * FW, i, frames);
  writeFileSync(path.join(outDir, `${name}.png`), encodePng(img));
  console.log(`${name}.png  (${frames} frames, ${img.w}x${img.h})`);
}
