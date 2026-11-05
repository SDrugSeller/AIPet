// 현장냥이 스킨 생성기의 그리기 코드. Electron 숨김 창(브라우저 컨텍스트)에서 실행된다.
// 원본 한 장(source.webp)에서 배경을 지우고, 몸을 격자 메시로 덮어 관절 부분만 휘게(메시 워프) 해서
// 애니메이션 프레임을 만든다. 새로운 포즈를 그리는 것이 아니라 한 장을 변형하는 방식이다.

const SS = 3; // 슈퍼샘플링 배율 (부드러운 가장자리를 위해 크게 그린 뒤 줄인다)
const FRAME = 160; // 출력 프레임 크기(px)
const S = 0.5; // 원본 → 프레임 축소 비율
const SRC_ANCHOR = [150, 292]; // 원본에서 발 위치 (좌우 중앙, 바닥)
const FRAME_ANCHOR = [80, 156]; // 프레임에서 발 위치
const GRID = 56; // 메시 격자 수 (눈 깜빡임처럼 작은 부위를 변형할 만큼 촘촘하게)

/** @param {number} w @param {number} h */
function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

// ---------------------------------------------------------------- 배경 제거

/**
 * 흰 배경을 지우고 고양이(가장 큰 덩어리)와 "ヨシ!" 글자를 분리한다.
 * @param {HTMLImageElement} img
 */
function cutout(img) {
  const W = img.naturalWidth;
  const H = img.naturalHeight;
  const src = makeCanvas(W, H);
  const sx = src.getContext('2d', { willReadFrequently: true });
  sx.drawImage(img, 0, 0);
  const d = sx.getImageData(0, 0, W, H).data;

  // 배경처럼 보이는 색: 거의 흰색 (옅은 노란 번짐 포함). 헬멧 노랑/눈동자는 파란 성분이 낮아 제외된다.
  const bgLike = (p) => d[p * 4] >= 225 && d[p * 4 + 1] >= 225 && d[p * 4 + 2] >= 180;

  // 가장자리에서 시작해 이어진 배경만 지운다 (고양이 안쪽의 흰색은 남긴다).
  const bg = new Uint8Array(W * H);
  const stack = [];
  const push = (x, y) => {
    const p = y * W + x;
    if (!bg[p] && bgLike(p)) {
      bg[p] = 1;
      stack.push(p);
    }
  };
  for (let x = 0; x < W; x++) {
    push(x, 0);
    push(x, H - 1);
  }
  for (let y = 0; y < H; y++) {
    push(0, y);
    push(W - 1, y);
  }
  while (stack.length) {
    const p = stack.pop();
    const x = p % W;
    const y = (p / W) | 0;
    if (x > 0) push(x - 1, y);
    if (x < W - 1) push(x + 1, y);
    if (y > 0) push(x, y - 1);
    if (y < H - 1) push(x, y + 1);
  }

  // 남은 덩어리 라벨링 (8방향)
  const label = new Int32Array(W * H).fill(-1);
  const comps = [];
  for (let start = 0; start < W * H; start++) {
    if (bg[start] || label[start] >= 0) continue;
    const id = comps.length;
    const comp = { id, size: 0, x0: W, y0: H, x1: 0, y1: 0 };
    const q = [start];
    label[start] = id;
    while (q.length) {
      const p = q.pop();
      const x = p % W;
      const y = (p / W) | 0;
      comp.size++;
      comp.x0 = Math.min(comp.x0, x);
      comp.x1 = Math.max(comp.x1, x);
      comp.y0 = Math.min(comp.y0, y);
      comp.y1 = Math.max(comp.y1, y);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
          const np = ny * W + nx;
          if (!bg[np] && label[np] < 0) {
            label[np] = id;
            q.push(np);
          }
        }
      }
    }
    comps.push(comp);
  }
  const catId = comps.reduce((a, b) => (b.size > a.size ? b : a)).id;
  // 글자 "ヨ シ !": 고양이가 아닌 덩어리 중 왼쪽 위에 있는 것들
  const isText = (c) => c.id !== catId && c.size >= 12 && c.x1 < 90 && c.y0 > 60 && c.y1 < 120;

  /** 가장자리 픽셀은 흰 배경과 섞여 있으므로, 안쪽 색을 기준으로 투명도를 되살린다 ("color to alpha"). */
  const isEdge = (p) => {
    const x = p % W;
    const y = (p / W) | 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= W || ny >= H || bg[ny * W + nx]) return true;
      }
    }
    return false;
  };
  const luma = (r, g, b) => 0.299 * r + 0.587 * g + 0.114 * b;

  /** @param {(p: number) => boolean} keep */
  const extract = (keep) => {
    const out = new Uint8ClampedArray(W * H * 4);
    for (let p = 0; p < W * H; p++) {
      if (bg[p] || !keep(p)) continue;
      let r = d[p * 4];
      let g = d[p * 4 + 1];
      let b = d[p * 4 + 2];
      let a = 255;
      if (isEdge(p)) {
        // 주변의 (가장자리가 아닌) 불투명 픽셀 평균색 = 이 픽셀의 "진짜" 색
        const x = p % W;
        const y = (p / W) | 0;
        let n = 0;
        let sr = 0;
        let sg = 0;
        let sb = 0;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            const nx = x + dx;
            const ny = y + dy;
            if (nx < 0 || ny < 0 || nx >= W || ny >= H) continue;
            const np = ny * W + nx;
            if (bg[np] || !keep(np) || isEdge(np)) continue;
            n++;
            sr += d[np * 4];
            sg += d[np * 4 + 1];
            sb += d[np * 4 + 2];
          }
        }
        if (n > 0) {
          const cr = sr / n;
          const cg = sg / n;
          const cb = sb / n;
          const lc = luma(cr, cg, cb);
          const lp = luma(r, g, b);
          if (lc < 235) {
            a = Math.round(255 * Math.min(1, Math.max(0, (255 - lp) / (255 - lc))));
            [r, g, b] = [cr, cg, cb];
          }
        }
      }
      out[p * 4] = r;
      out[p * 4 + 1] = g;
      out[p * 4 + 2] = b;
      out[p * 4 + 3] = a;
    }
    const c = makeCanvas(W, H);
    c.getContext('2d').putImageData(new ImageData(out, W, H), 0, 0);
    return c;
  };

  const catCanvas = extract((p) => label[p] === catId);
  const textCanvas = extract((p) => isText(comps[label[p]]));
  const cat = comps[catId];
  return { cat: catCanvas, text: textCanvas, bbox: { x0: cat.x0 - 2, y0: cat.y0 - 2, x1: cat.x1 + 3, y1: cat.y1 + 3 }, W, H };
}

// ---------------------------------------------------------------- 메시 워프

/**
 * 변형기: 원본 좌표계에서 타원 영역(중심 cx,cy 반지름 rx,ry)에 가중치를 주고,
 *  - rot: pivot을 중심으로 angle(도, 시계 방향이 +)만큼 돌린다
 *  - scale: 중심 기준으로 sx, sy 배로 늘이거나 줄인다
 * core(0~1) 안쪽은 가중치 1, 바깥으로 부드럽게 0까지 줄어든다.
 * @typedef {{ kind: 'rot' | 'scale', cx: number, cy: number, rx: number, ry: number, core: number,
 *   pivot?: [number, number], angle?: number, sx?: number, sy?: number, tx?: number, ty?: number }} Deformer
 * @typedef {{ sx?: number, sy?: number, rot?: number, tx?: number, ty?: number }} GlobalXf
 */

/** 몸의 관절 위치 (원본 310×310 기준). page 맨 아래 `rig`로 이름 붙여 쓴다. */
const RIG = {
  head: { kind: 'rot', cx: 140, cy: 92, rx: 82, ry: 88, core: 0.55, pivot: [140, 168] },
  armL: { kind: 'rot', cx: 66, cy: 148, rx: 52, ry: 36, core: 0.5, pivot: [120, 172] }, // 손가락질하는 팔
  armR: { kind: 'rot', cx: 240, cy: 124, rx: 44, ry: 46, core: 0.5, pivot: [208, 122] }, // 주먹 쥔 팔
  legL: { kind: 'rot', cx: 118, cy: 250, rx: 42, ry: 40, core: 0.5, pivot: [132, 214] },
  legR: { kind: 'rot', cx: 192, cy: 268, rx: 34, ry: 38, core: 0.5, pivot: [188, 226] },
  tail: { kind: 'rot', cx: 246, cy: 252, rx: 44, ry: 40, core: 0.45, pivot: [214, 226] },
  mouth: { kind: 'scale', cx: 140, cy: 132, rx: 26, ry: 20, core: 0.5 },
  eyeL: { kind: 'scale', cx: 113, cy: 96, rx: 14, ry: 14, core: 0.6 },
  eyeR: { kind: 'scale', cx: 157, cy: 96, rx: 14, ry: 14, core: 0.6 },
};

/** @param {Deformer} d @param {number} x @param {number} y */
function weight(d, x, y) {
  const r = Math.hypot((x - d.cx) / d.rx, (y - d.cy) / d.ry);
  const t = Math.min(1, Math.max(0, (1 - r) / (1 - d.core)));
  return t * t * (3 - 2 * t);
}

/**
 * 한 프레임의 변형을 점 단위 함수로 만든다. 반환값은 슈퍼샘플링된 프레임 좌표.
 * @param {{ global?: GlobalXf, parts?: Record<string, Partial<Deformer>> }} pose
 */
function makeWarp(pose) {
  const g = { sx: 1, sy: 1, rot: 0, tx: 0, ty: 0, ...pose.global };
  const act = Object.entries(pose.parts ?? {}).map(([name, p]) => ({ ...RIG[name], ...p }));
  const gr = (g.rot * Math.PI) / 180;
  const gc = Math.cos(gr);
  const gs = Math.sin(gr);
  const [ax, ay] = SRC_ANCHOR;

  return (/** @type {number} */ x, /** @type {number} */ y) => {
    let dx = 0;
    let dy = 0;
    for (const d of act) {
      const w = weight(d, x, y);
      if (w <= 0) continue;
      if (d.kind === 'rot') {
        const a = ((d.angle ?? 0) * Math.PI) / 180;
        const c = Math.cos(a);
        const s = Math.sin(a);
        const [px, py] = /** @type {[number, number]} */ (d.pivot);
        dx += w * (px + c * (x - px) - s * (y - py) - x + (d.tx ?? 0));
        dy += w * (py + s * (x - px) + c * (y - py) - y + (d.ty ?? 0));
      } else {
        dx += w * (((d.sx ?? 1) - 1) * (x - d.cx) + (d.tx ?? 0));
        dy += w * (((d.sy ?? 1) - 1) * (y - d.cy) + (d.ty ?? 0));
      }
    }
    // 몸 전체 변형: 발 위치를 기준으로 늘이고, 돌리고, 옮긴다.
    const lx = (x + dx - ax) * g.sx;
    const ly = (y + dy - ay) * g.sy;
    const wx = ax + gc * lx - gs * ly + g.tx;
    const wy = ay + gs * lx + gc * ly + g.ty;
    return [((wx - ax) * S + FRAME_ANCHOR[0]) * SS, ((wy - ay) * S + FRAME_ANCHOR[1]) * SS];
  };
}

/**
 * 원본을 삼각형 메시로 나눠 변형한 그림을 그린다.
 * @param {HTMLCanvasElement} srcCanvas @param {{x0:number,y0:number,x1:number,y1:number}} bbox
 * @param {(x: number, y: number) => [number, number]} warp
 */
function drawWarped(srcCanvas, bbox, warp, occupied) {
  const out = makeCanvas(FRAME * SS, FRAME * SS);
  const ctx = out.getContext('2d');
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  const cw = (bbox.x1 - bbox.x0) / GRID;
  const ch = (bbox.y1 - bbox.y0) / GRID;

  // 격자 꼭짓점을 한 번만 변형한다.
  const grid = [];
  for (let j = 0; j <= GRID; j++) {
    const row = [];
    for (let i = 0; i <= GRID; i++) {
      const sx = bbox.x0 + i * cw;
      const sy = bbox.y0 + j * ch;
      row.push({ sx, sy, d: warp(sx, sy) });
    }
    grid.push(row);
  }

  /** 삼각형 하나를 원본에서 변형된 위치로 옮겨 그린다. 이음새가 비지 않게 살짝 부풀려서 자른다. */
  const tri = (a, b, c) => {
    const det = (b.sx - a.sx) * (c.sy - a.sy) - (c.sx - a.sx) * (b.sy - a.sy);
    if (Math.abs(det) < 1e-9) return;
    const [u0, v0] = a.d;
    const [u1, v1] = b.d;
    const [u2, v2] = c.d;
    const m = {
      a: ((u1 - u0) * (c.sy - a.sy) - (u2 - u0) * (b.sy - a.sy)) / det,
      c: ((u2 - u0) * (b.sx - a.sx) - (u1 - u0) * (c.sx - a.sx)) / det,
      b: ((v1 - v0) * (c.sy - a.sy) - (v2 - v0) * (b.sy - a.sy)) / det,
      d: ((v2 - v0) * (b.sx - a.sx) - (v1 - v0) * (c.sx - a.sx)) / det,
    };
    const e = u0 - m.a * a.sx - m.c * a.sy;
    const f = v0 - m.b * a.sx - m.d * a.sy;

    const cx = (u0 + u1 + u2) / 3;
    const cy = (v0 + v1 + v2) / 3;
    ctx.save();
    ctx.beginPath();
    [[u0, v0], [u1, v1], [u2, v2]].forEach(([u, v], k) => {
      const l = Math.hypot(u - cx, v - cy) || 1;
      const px = u + ((u - cx) / l) * 0.8;
      const py = v + ((v - cy) / l) * 0.8;
      if (k === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.closePath();
    ctx.clip();
    ctx.transform(m.a, m.b, m.c, m.d, e, f);
    const x0 = Math.min(a.sx, b.sx, c.sx) - 1;
    const y0 = Math.min(a.sy, b.sy, c.sy) - 1;
    const w = Math.max(a.sx, b.sx, c.sx) - x0 + 1;
    const h = Math.max(a.sy, b.sy, c.sy) - y0 + 1;
    ctx.drawImage(srcCanvas, x0, y0, w, h, x0, y0, w, h);
    ctx.restore();
  };

  for (let j = 0; j < GRID; j++) {
    for (let i = 0; i < GRID; i++) {
      if (!occupied[j * GRID + i]) continue; // 그림이 없는 칸은 건너뛴다
      const p00 = grid[j][i];
      const p10 = grid[j][i + 1];
      const p01 = grid[j + 1][i];
      const p11 = grid[j + 1][i + 1];
      tri(p00, p10, p01);
      tri(p10, p11, p01);
    }
  }
  return out;
}

/** 그림이 있는 칸만 표시한다 (속도를 위해). @param {HTMLCanvasElement} c @param {{x0:number,y0:number,x1:number,y1:number}} bbox */
function occupancy(c, bbox) {
  const x = c.getContext('2d', { willReadFrequently: true });
  const cw = (bbox.x1 - bbox.x0) / GRID;
  const ch = (bbox.y1 - bbox.y0) / GRID;
  const occ = new Uint8Array(GRID * GRID);
  for (let j = 0; j < GRID; j++) {
    for (let i = 0; i < GRID; i++) {
      const sx = Math.max(0, Math.floor(bbox.x0 + i * cw) - 1);
      const sy = Math.max(0, Math.floor(bbox.y0 + j * ch) - 1);
      const w = Math.ceil(cw) + 3;
      const h = Math.ceil(ch) + 3;
      const data = x.getImageData(sx, sy, Math.min(w, c.width - sx), Math.min(h, c.height - sy)).data;
      for (let k = 3; k < data.length; k += 4) {
        if (data[k] > 0) {
          occ[j * GRID + i] = 1;
          break;
        }
      }
    }
  }
  return occ;
}

// ---------------------------------------------------------------- 효과 (프레임 좌표, 왼쪽을 바라보는 기준)

const ink = '#2b2b2b';

/** 원본 좌표를 프레임 좌표로 (변형 반영) */
const at = (warp, x, y) => {
  const [u, v] = warp(x, y);
  return [u / SS, v / SS];
};

function sweat(ctx, x, y) {
  ctx.fillStyle = 'rgba(110,185,255,0.95)';
  ctx.beginPath();
  ctx.moveTo(x, y - 6);
  ctx.quadraticCurveTo(x + 5, y + 1, x, y + 5);
  ctx.quadraticCurveTo(x - 5, y + 1, x, y - 6);
  ctx.fill();
}

function sparkle(ctx, x, y, r, alpha = 1) {
  ctx.strokeStyle = `rgba(255,205,60,${alpha})`;
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x - r, y);
  ctx.lineTo(x + r, y);
  ctx.moveTo(x, y - r);
  ctx.lineTo(x, y + r);
  ctx.stroke();
}

function zzz(ctx, x, y, size, alpha) {
  ctx.strokeStyle = `rgba(110,140,255,${alpha})`;
  ctx.lineWidth = 2.4;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + size, y);
  ctx.lineTo(x, y + size);
  ctx.lineTo(x + size, y + size);
  ctx.stroke();
}

function exclaim(ctx, x, y) {
  ctx.strokeStyle = '#ee3b3b';
  ctx.fillStyle = '#ee3b3b';
  ctx.lineWidth = 4.5;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x, y + 13);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(x, y + 21, 2.8, 0, Math.PI * 2);
  ctx.fill();
}

function crossEye(ctx, x, y) {
  ctx.strokeStyle = ink;
  ctx.lineWidth = 3;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(x - 5.5, y - 5.5);
  ctx.lineTo(x + 5.5, y + 5.5);
  ctx.moveTo(x - 5.5, y + 5.5);
  ctx.lineTo(x + 5.5, y - 5.5);
  ctx.stroke();
}

function thinkDots(ctx, x, y, n) {
  ctx.fillStyle = 'rgba(120,120,130,0.95)';
  for (let k = 0; k < n; k++) {
    ctx.beginPath();
    ctx.arc(x + k * 11, y - k * 4, 4, 0, Math.PI * 2);
    ctx.fill();
  }
}

// ---------------------------------------------------------------- 동작 정의

const TAU = Math.PI * 2;
const sin = (/** @type {number} */ t) => Math.sin(TAU * t);

/**
 * 애니메이션: 프레임 수와, 프레임(i/n)마다 포즈와 효과를 돌려주는 함수.
 * 각도는 +가 시계 방향이다. (왼팔은 +가 올리는 방향, 오른팔은 −가 올리는 방향)
 * @type {Record<string, { frames: number, pose: (p: number, i: number) => any, fx?: (ctx: CanvasRenderingContext2D, p: number, i: number, warp: any, ctxs: any) => void }>}
 */
const ANIMS = {
  idle: {
    frames: 6,
    pose: (p, i) => ({
      global: { sy: 1 + 0.018 * sin(p), sx: 1 - 0.01 * sin(p) },
      parts: {
        head: { angle: 2 * sin(p + 0.1), ty: -0.8 * sin(p) },
        armL: { angle: 3 * sin(p + 0.2) },
        armR: { angle: -3 * sin(p + 0.2) },
        tail: { angle: 8 * sin(p + 0.3) },
        ...(i === 4 ? { eyeL: { sy: 0.1 }, eyeR: { sy: 0.1 } } : {}), // 깜빡임
      },
    }),
  },
  walk: {
    frames: 8,
    pose: (p) => {
      const s = sin(p);
      return {
        global: { ty: -4 * Math.abs(s), rot: 4 * s },
        parts: {
          legL: { angle: 15 * s, ty: -7 * Math.max(0, s) },
          legR: { angle: -15 * s, ty: -7 * Math.max(0, -s) },
          armL: { angle: -9 * s },
          armR: { angle: 11 * s },
          head: { angle: -2.5 * s },
          tail: { angle: 12 * sin(p + 0.15) },
        },
      };
    },
  },
  drag: {
    frames: 3,
    pose: (p, i) => ({
      global: { sy: 1.05, sx: 0.97, rot: [-5, 0, 5][i] },
      parts: {
        legL: { angle: [10, 15, 8][i] },
        legR: { angle: [-8, -13, -6][i] },
        armL: { angle: 18 },
        armR: { angle: -22 },
        head: { angle: [3, 0, -3][i] },
        tail: { angle: [10, -10, 10][i] },
        eyeL: { sx: 1.18, sy: 1.18 },
        eyeR: { sx: 1.18, sy: 1.18 },
      },
    }),
  },
  drop: {
    frames: 4,
    pose: (p, i) => ({
      global: { sy: [0.86, 0.8, 0.93, 1][i], sx: [1.1, 1.16, 1.05, 1][i] },
      parts: { head: { angle: [-4, -6, -2, 0][i] }, tail: { angle: [10, 14, 6, 0][i] } },
    }),
  },
  sleep: {
    frames: 4,
    pose: (p) => ({
      global: { sy: 0.94 + 0.012 * sin(p), sx: 1.03 },
      parts: {
        head: { angle: 9 + 1.5 * sin(p), ty: 3 },
        armL: { angle: -8 },
        armR: { angle: 8 },
        tail: { angle: 4 * sin(p) },
        eyeL: { sy: 0.08 },
        eyeR: { sy: 0.08 },
        mouth: { sy: 0.3, sx: 0.8 },
      },
    }),
    fx: (ctx, p, i) => {
      zzz(ctx, 118, 36 - i * 2.5, 9, 1 - i / 5);
      zzz(ctx, 130, 22 - i * 1.5, 6, 0.55 + 0.45 * (i / 4));
    },
  },
  think: {
    frames: 6,
    pose: (p) => ({
      global: { sy: 1 + 0.012 * sin(p) },
      parts: {
        head: { angle: 7 + 1.5 * sin(p) },
        armL: { angle: 4 * sin(p) },
        tail: { angle: 5 * sin(p + 0.2) },
        mouth: { sy: 0.5, sx: 0.85 },
      },
    }),
    fx: (ctx, p, i, warp) => {
      const [x, y] = at(warp, 206, 52);
      thinkDots(ctx, x, y, 1 + (i % 3));
    },
  },
  work: {
    frames: 8,
    pose: (p, i) => {
      const s = sin(p * 2);
      return {
        global: { ty: -1.5 * Math.abs(s), tx: i % 2 ? 1 : -1 },
        parts: {
          armL: { angle: 14 * s },
          armR: { angle: -14 * s },
          head: { angle: 2.5 * s },
          eyeL: { sy: 0.55 },
          eyeR: { sy: 0.55 },
          tail: { angle: 10 * sin(p * 2) },
        },
      };
    },
    fx: (ctx, p, i, warp) => {
      const [x, y] = at(warp, 212, 92);
      sweat(ctx, x, y + (i % 4) * 3);
      sparkle(ctx, 22 + (i % 4) * 3, 60 + (i % 3) * 8, 3 + (i % 2), 0.9);
    },
  },
  talk: {
    frames: 4,
    pose: (p, i) => ({
      global: { ty: [0, -1.5, 0, -1][i] },
      parts: {
        mouth: { sy: [0.7, 1.2, 0.9, 1.25][i], sx: [1, 1.05, 1, 1.05][i] },
        head: { angle: [-1.5, 1.5, -1.5, 1.5][i] },
        armL: { angle: [2, -2, 2, -2][i] },
      },
    }),
  },
  done: {
    frames: 8,
    pose: (p, i) => {
      const h = Math.sin(Math.PI * (i / 7));
      return {
        global: { ty: -22 * h, sy: 1 + 0.04 * h, sx: 1 - 0.02 * h },
        parts: {
          armL: { angle: 28 * h },
          armR: { angle: -30 * h },
          legL: { angle: 10 * h },
          legR: { angle: -10 * h },
          head: { angle: -3 * h },
          tail: { angle: 14 * h },
          mouth: { sy: 1.15 },
        },
      };
    },
    fx: (ctx, p, i, warp, c) => {
      // "ヨシ!" 를 외친다 (원본에서 떼어 둔 글자)
      if (i >= 1) {
        const k = Math.min(1, (i - 1) / 2);
        const w = 46 * (0.7 + 0.3 * k);
        const h = (c.textBox.h * w) / c.textBox.w;
        ctx.globalAlpha = Math.min(1, k + 0.2);
        ctx.drawImage(c.text, c.textBox.x, c.textBox.y, c.textBox.w, c.textBox.h, 3, 26 - (i % 2), w, h);
        ctx.globalAlpha = 1;
      }
      if (i >= 2) {
        sparkle(ctx, 112, 24 + (i % 3) * 4, 4, 0.95);
        sparkle(ctx, 134, 52 - (i % 2) * 5, 5, 0.95);
      }
    },
  },
  error: {
    frames: 6,
    pose: (p, i) => ({
      global: { rot: [6, -6, 4, -4, 2, -2][i], sy: 0.96 },
      parts: {
        head: { angle: 8 },
        armL: { angle: -12 },
        armR: { angle: 16 },
        tail: { angle: -8 },
        eyeL: { sy: 0.1 },
        eyeR: { sy: 0.1 },
        mouth: { sy: 0.45, sx: 0.9 },
      },
    }),
    fx: (ctx, p, i, warp) => {
      for (const [x, y] of [[113, 96], [157, 96]]) {
        const [fx, fy] = at(warp, x, y);
        crossEye(ctx, fx, fy);
      }
      const [sx, sy] = at(warp, 210, 96);
      sweat(ctx, sx, sy + (i % 3) * 3);
    },
  },
  attention: {
    frames: 6,
    pose: (p) => {
      const h = Math.abs(sin(p / 2));
      return {
        global: { ty: -6 * h },
        parts: {
          armL: { angle: 22 + 4 * sin(p * 2) },
          armR: { angle: -22 - 4 * sin(p * 2) },
          eyeL: { sx: 1.2, sy: 1.2 },
          eyeR: { sx: 1.2, sy: 1.2 },
          head: { angle: 2 * sin(p * 2) },
        },
      };
    },
    fx: (ctx, p, i) => exclaim(ctx, 112, 8 + Math.abs(sin(i / 12)) * 4),
  },
};

// ---------------------------------------------------------------- 실행

/**
 * @param {string} webpDataUrl
 * @returns {Promise<{ sheets: Record<string, string>, info: any, debug: Record<string, string> }>}
 */
async function build(webpDataUrl) {
  const img = new Image();
  img.src = webpDataUrl;
  await img.decode();
  const { cat, text, bbox } = cutout(img);
  const occ = occupancy(cat, bbox);

  // 글자 이미지의 실제 영역
  const tctx = text.getContext('2d', { willReadFrequently: true });
  const td = tctx.getImageData(0, 0, text.width, text.height).data;
  let tx0 = text.width, ty0 = text.height, tx1 = 0, ty1 = 0;
  for (let y = 0; y < text.height; y++) {
    for (let x = 0; x < text.width; x++) {
      if (td[(y * text.width + x) * 4 + 3] > 0) {
        tx0 = Math.min(tx0, x); tx1 = Math.max(tx1, x); ty0 = Math.min(ty0, y); ty1 = Math.max(ty1, y);
      }
    }
  }
  const textBox = { x: tx0 - 4, y: ty0 - 4, w: tx1 - tx0 + 9, h: ty1 - ty0 + 9 };
  // 어떤 배경에서도 보이도록 흰 테두리를 두른다
  const sticker = makeCanvas(text.width, text.height);
  {
    const sc = sticker.getContext('2d');
    const white = makeCanvas(text.width, text.height);
    const wc = white.getContext('2d');
    wc.drawImage(text, 0, 0);
    wc.globalCompositeOperation = 'source-in';
    wc.fillStyle = '#fff';
    wc.fillRect(0, 0, white.width, white.height);
    for (let a = 0; a < 16; a++) {
      const r = a % 2 ? 2.2 : 3.2;
      sc.drawImage(white, Math.cos((a / 16) * TAU) * r, Math.sin((a / 16) * TAU) * r);
    }
    sc.drawImage(text, 0, 0);
  }

  /** @type {Record<string, string>} */
  const sheets = {};
  /** @type {Record<string, number>} */
  const frames = {};
  for (const [name, anim] of Object.entries(ANIMS)) {
    const strip = makeCanvas(FRAME * anim.frames, FRAME);
    const sctx = strip.getContext('2d');
    sctx.imageSmoothingEnabled = true;
    sctx.imageSmoothingQuality = 'high';
    for (let i = 0; i < anim.frames; i++) {
      const p = i / anim.frames;
      const warp = makeWarp(anim.pose(p, i));
      const big = drawWarped(cat, bbox, warp, occ);
      const bctx = big.getContext('2d');
      bctx.save();
      bctx.scale(SS, SS);
      anim.fx?.(bctx, p, i, warp, { text: sticker, textBox });
      bctx.restore();
      sctx.drawImage(big, 0, 0, big.width, big.height, i * FRAME, 0, FRAME, FRAME);
    }
    sheets[name] = strip.toDataURL('image/png');
    frames[name] = anim.frames;
  }

  // 설정에 쓸 값: 발 위치(anchor)와 히트박스(머리~발, 팔 끝 제외)
  const toFrame = (x, y) => [(x - SRC_ANCHOR[0]) * S + FRAME_ANCHOR[0], (y - SRC_ANCHOR[1]) * S + FRAME_ANCHOR[1]];
  const [hx0, hy0] = toFrame(80, 28);
  const [hx1, hy1] = toFrame(228, 292);
  const info = {
    frameSize: { w: FRAME, h: FRAME },
    anchor: { x: FRAME_ANCHOR[0], y: FRAME_ANCHOR[1] },
    hitbox: { x: Math.round(hx0), y: Math.round(hy0), w: Math.round(hx1 - hx0), h: Math.round(hy1 - hy0) },
    frames,
  };

  const debug = { cutout: cat.toDataURL('image/png'), text: text.toDataURL('image/png') };
  return { sheets, info, debug };
}
