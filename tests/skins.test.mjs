// @ts-check
// skins/ 아래의 모든 스킨이 스키마의 핵심 규칙과 실제 이미지 크기를 지키는지 확인한다.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const skinsRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../skins');
const skinDirs = fs
  .readdirSync(skinsRoot, { withFileTypes: true })
  .filter((d) => d.isDirectory() && fs.existsSync(path.join(skinsRoot, d.name, 'skin.json')))
  .map((d) => d.name);

/** PNG 헤더에서 크기를 읽는다 @param {string} file */
function pngSize(file) {
  const b = fs.readFileSync(file);
  assert.equal(b.subarray(1, 4).toString('ascii'), 'PNG', `${file}는 PNG가 아니에요`);
  return { w: b.readUInt32BE(16), h: b.readUInt32BE(20) };
}

test('스킨 폴더가 하나 이상 있다', () => {
  assert.ok(skinDirs.includes('default'));
});

for (const id of skinDirs) {
  const dir = path.join(skinsRoot, id);
  const skin = JSON.parse(fs.readFileSync(path.join(dir, 'skin.json'), 'utf8'));

  test(`[${id}] 필수 항목: idle, 프레임 크기, 기준점, 히트박스`, () => {
    assert.ok(skin.animations.idle, 'idle은 필수');
    assert.ok(skin.frameSize.w > 0 && skin.frameSize.h > 0);
    assert.ok(skin.anchor.x >= 0 && skin.anchor.x <= skin.frameSize.w);
    assert.ok(skin.anchor.y >= 0 && skin.anchor.y <= skin.frameSize.h);
    const hb = skin.hitbox;
    if (hb) {
      assert.ok(hb.x >= 0 && hb.y >= 0 && hb.x + hb.w <= skin.frameSize.w && hb.y + hb.h <= skin.frameSize.h, '히트박스가 프레임 안에 있어야 해요');
    }
  });

  test(`[${id}] 시트 경로는 스킨 폴더 안이고, 이미지 크기가 프레임 수와 맞는다`, () => {
    for (const [name, a] of Object.entries(skin.animations)) {
      assert.match(a.sheet, /^[A-Za-z0-9_./-]+\.png$/, `${name}: 시트 경로 형식`);
      assert.ok(!a.sheet.includes('..') && !path.isAbsolute(a.sheet), `${name}: 폴더 밖 경로 금지`);
      const file = path.join(dir, a.sheet);
      if (!fs.existsSync(file)) {
        // idle만 필수다. 나머지는 없으면 fallbacks → idle로 대체된다.
        assert.notEqual(name, 'idle', 'idle 시트는 필수예요');
        continue;
      }
      const { w, h } = pngSize(file);
      assert.equal(w, skin.frameSize.w * a.frames, `${name}: 너비는 frameSize.w × frames여야 해요`);
      assert.equal(h, skin.frameSize.h, `${name}: 높이는 frameSize.h여야 해요`);
    }
  });

  test(`[${id}] fallbacks와 next는 존재하는 상태를 가리킨다`, () => {
    const known = new Set([...Object.keys(skin.animations), 'fall', 'run', 'sit', 'sleep', 'react', 'talk', 'attention', 'error']);
    for (const [from, to] of Object.entries(skin.fallbacks ?? {})) {
      assert.ok(known.has(to) || skin.animations[to], `${from} → ${to}`);
    }
    for (const [name, a] of Object.entries(skin.animations)) {
      if (a.next) assert.ok(skin.animations[a.next], `${name}.next=${a.next}`);
    }
  });
}
