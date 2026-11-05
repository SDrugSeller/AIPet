// 현장냥이 스킨 생성기. Electron의 캔버스를 이용하므로 electron으로 실행한다:
//   npx electron tools/genba/build.cjs
// skins/genba-cat/source.webp 한 장에서 skins/genba-cat/*.png 시트를 만든다. (그리기 코드는 page.js)
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');

const skinDir = path.resolve(__dirname, '../../skins/genba-cat');
const debugDir = process.env.GENBA_DEBUG_DIR;

app.whenReady().then(async () => {
  try {
    const win = new BrowserWindow({ show: false, webPreferences: { contextIsolation: true } });
    await win.loadURL('data:text/html,<meta charset=utf-8><body></body>');

    const page = fs.readFileSync(path.join(__dirname, 'page.js'), 'utf8');
    const webp = fs.readFileSync(path.join(skinDir, 'source.webp')).toString('base64');
    const result = await win.webContents.executeJavaScript(`${page}\n;build('data:image/webp;base64,${webp}')`);

    const save = (/** @type {string} */ file, /** @type {string} */ dataUrl) =>
      fs.writeFileSync(file, Buffer.from(dataUrl.split(',')[1], 'base64'));

    for (const [name, dataUrl] of Object.entries(result.sheets)) {
      save(path.join(skinDir, `${name}.png`), /** @type {string} */ (dataUrl));
      console.log(`${name}.png  (${result.info.frames[name]} frames)`);
    }
    if (debugDir) {
      fs.mkdirSync(debugDir, { recursive: true });
      for (const [name, dataUrl] of Object.entries(result.debug)) save(path.join(debugDir, `genba-${name}.png`), /** @type {string} */ (dataUrl));
    }
    console.log('frameSize', JSON.stringify(result.info.frameSize), 'anchor', JSON.stringify(result.info.anchor), 'hitbox', JSON.stringify(result.info.hitbox));
    app.exit(0);
  } catch (e) {
    console.error('실패:', e);
    app.exit(1);
  }
});
