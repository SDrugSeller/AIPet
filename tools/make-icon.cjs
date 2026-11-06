// 앱 아이콘(build/icon.png, 256x256)을 default 스킨의 idle 첫 프레임에서 만든다.
// 실행: npx electron tools/make-icon.cjs
// 최종 캐릭터 아트가 정해지면 build/icon.png를 직접 교체하면 된다 (256x256 이상 PNG).
const { app, nativeImage } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

app.whenReady().then(() => {
  const root = path.resolve(__dirname, '..');
  const skin = JSON.parse(fs.readFileSync(path.join(root, 'skins/default/skin.json'), 'utf8'));
  const { w, h } = skin.frameSize;
  const sheet = nativeImage.createFromPath(path.join(root, 'skins/default', skin.animations.idle.sheet));
  // 첫 프레임을 잘라 캐릭터가 차지하는 영역(hitbox) 기준으로 정사각형 여백을 두고 확대한다.
  const frame = sheet.crop({ x: 0, y: 0, width: w, height: h });
  const icon = frame.resize({ width: 256, height: 256, quality: 'best' });
  fs.mkdirSync(path.join(root, 'build'), { recursive: true });
  fs.writeFileSync(path.join(root, 'build/icon.png'), icon.toPNG());
  console.log('wrote build/icon.png', icon.getSize());
  app.quit();
});
