// @ts-check
import { BrowserWindow, Menu, app, ipcMain, screen } from 'electron';

/**
 * 모니터마다 투명 오버레이 창을 하나씩 만들고, 펫 좌표(가상 데스크톱 기준, DIP)는
 * 여기서 단일 상태로 관리해 모든 창에 브로드캐스트한다.
 * 펫이 모니터 경계에 걸치면 양쪽 창이 각자 자기 영역만 그린다.
 *
 * @param {{ skin: any, preloadPath: string, rendererPath: string, debug: boolean }} opts
 */
export function createOverlayManager({ skin, preloadPath, rendererPath, debug }) {
  /** @type {Map<number, BrowserWindow>} displayId → 오버레이 창 */
  const windows = new Map();
  // 펫은 항상 한 모니터(display)에만 속하고, 그 모니터의 창에서만 그려진다.
  // 배율이 다른 모니터 사이의 DIP 좌표는 경계에서 끊어지므로, 경계에 걸쳐 그리지 않는다.
  const pet = { x: 0, y: 0, dragging: false, display: 0 };
  const headroom = skin.anchor.y * skin.scale;
  const halfLeft = skin.anchor.x * skin.scale;
  const halfRight = (skin.frameSize.w - skin.anchor.x) * skin.scale;

  /** @param {Electron.WebContents} sender */
  function findDisplayId(sender) {
    for (const [id, win] of windows) {
      if (win.webContents === sender) return id;
    }
    return null;
  }

  /** @param {number} id */
  function boundsOf(id) {
    return screen.getAllDisplays().find((d) => d.id === id)?.bounds ?? null;
  }

  /** @param {Electron.Rectangle} a @param {Electron.Rectangle} b */
  function sameRect(a, b) {
    return a.x === b.x && a.y === b.y && a.width === b.width && a.height === b.height;
  }

  /** 혼합 DPI 환경에서 setBounds가 어긋나는 경우가 있어 한 번 더 맞춘다. */
  /** @param {BrowserWindow} win @param {Electron.Rectangle} bounds */
  function applyBounds(win, bounds) {
    win.setBounds(bounds);
    if (!sameRect(win.getBounds(), bounds)) win.setBounds(bounds);
  }

  /** 펫(발 위치 기준)을 자기 모니터 안에 완전히 들어오도록 제한한다. 모니터가 사라졌으면 가까운 모니터로 옮긴다. */
  function clampPet() {
    const d =
      screen.getAllDisplays().find((x) => x.id === pet.display) ??
      screen.getDisplayNearestPoint({ x: Math.round(pet.x), y: Math.round(pet.y) });
    const b = d.bounds;
    pet.display = d.id;
    pet.x = Math.min(Math.max(pet.x, b.x + halfLeft), b.x + b.width - halfRight);
    pet.y = Math.min(Math.max(pet.y, b.y + headroom), b.y + b.height);
  }

  function broadcast() {
    for (const win of windows.values()) {
      if (!win.isDestroyed()) win.webContents.send('pet:state', { ...pet });
    }
  }

  /** @param {Electron.Display} display */
  function createWindow(display) {
    const win = new BrowserWindow({
      ...display.bounds,
      transparent: true,
      backgroundColor: '#00000000',
      frame: false,
      thickFrame: false,
      hasShadow: false,
      resizable: false,
      movable: false,
      fullscreenable: false,
      skipTaskbar: true,
      focusable: false, // 클릭해도 다른 앱의 포커스를 빼앗지 않는다 (M3 입력창에서 재검토)
      show: false,
      webPreferences: {
        preload: preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    win.setAlwaysOnTop(true, 'screen-saver');
    win.setIgnoreMouseEvents(true, { forward: true }); // 기본은 클릭 통과
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.once('ready-to-show', () => {
      applyBounds(win, display.bounds);
      win.showInactive();
    });
    if (debug) {
      win.webContents.on('console-message', (e) => console.log(`[renderer ${display.id}]`, e.message));
      win.webContents.on('did-fail-load', (_e, code, desc) => console.log(`[load fail ${display.id}]`, code, desc));
      // AIPET_CAPTURE_DIR 지정 시 3초 뒤 각 창의 렌더링 결과를 PNG로 저장 (검증용)
      if (process.env.AIPET_CAPTURE_DIR) {
        win.once('show', () => setTimeout(async () => {
          const img = await win.webContents.capturePage();
          const { writeFile } = await import('node:fs/promises');
          await writeFile(`${process.env.AIPET_CAPTURE_DIR}/window-${display.id}.png`, img.toPNG());
        }, 3000));
      }
      win.once('show', () => console.log(`[window ${display.id}] bounds`, JSON.stringify(win.getBounds()), 'display', JSON.stringify(display.bounds)));
    }
    win.loadFile(rendererPath);

    windows.set(display.id, win);
  }

  /** 모니터 추가/제거/해상도 변경 시 창 목록과 위치를 맞춘다. */
  function syncDisplays() {
    const displays = screen.getAllDisplays();
    const live = new Set(displays.map((d) => d.id));

    for (const [id, win] of windows) {
      if (!live.has(id)) {
        windows.delete(id);
        win.destroy();
      }
    }
    for (const d of displays) {
      const win = windows.get(d.id);
      if (!win) {
        createWindow(d);
      } else if (!sameRect(win.getBounds(), d.bounds)) {
        applyBounds(win, d.bounds);
        win.webContents.send('overlay:bounds', d.bounds);
      }
    }
    clampPet();
    broadcast();
  }

  // --- IPC (화이트리스트 채널만, 보낸 쪽이 우리 오버레이 창인지 확인) ---

  ipcMain.handle('overlay:init', (e) => {
    const id = findDisplayId(e.sender);
    const bounds = id === null ? null : boundsOf(id);
    if (!bounds) throw new Error('알 수 없는 창');
    return { displayId: id, bounds, skin, pet: { ...pet }, debug };
  });

  ipcMain.on('overlay:set-interactive', (e, interactive) => {
    const id = findDisplayId(e.sender);
    if (id === null || typeof interactive !== 'boolean') return;
    windows.get(id)?.setIgnoreMouseEvents(!interactive, { forward: true });
  });

  // 드래그 중 좌표는 렌더러의 clientX/Y 대신 main의 커서 좌표를 쓴다.
  // 드래그를 시작한 창이 포인터를 계속 잡고 있는데, 그 창은 다른 모니터의 배율을 몰라
  // 배율이 다른 모니터로 넘어가면 clientX/Y가 어긋난다. getCursorScreenPoint는 모니터별 배율이 반영된 DIP 좌표다.
  // 포인터 이벤트는 모니터 경계를 넘는 순간 잠깐 끊길 수 있어, 드래그 중에는 이벤트 대신 타이머로 커서를 읽는다.
  /** @type {{ dx: number, dy: number } | null} */
  let grab = null;
  /** @type {NodeJS.Timeout | null} */
  let dragTimer = null;

  function followCursor() {
    if (!grab) return;
    const c = screen.getCursorScreenPoint();
    // 펫은 커서가 있는 모니터로 옮겨 간다 (커서와 같은 모니터 좌표계에서 계산).
    const display = screen.getDisplayNearestPoint(c).id;
    const before = { ...pet };
    pet.display = display;
    pet.x = c.x + grab.dx;
    pet.y = c.y + grab.dy;
    clampPet();
    if (pet.x === before.x && pet.y === before.y && pet.display === before.display) return;
    broadcast();
  }

  function stopDrag() {
    if (dragTimer) clearInterval(dragTimer);
    dragTimer = null;
    grab = null;
  }

  ipcMain.on('pet:dragging', (e, dragging) => {
    if (findDisplayId(e.sender) === null || typeof dragging !== 'boolean') return;
    stopDrag();
    pet.dragging = dragging;
    if (dragging) {
      const c = screen.getCursorScreenPoint();
      grab = { dx: pet.x - c.x, dy: pet.y - c.y };
      dragTimer = setInterval(followCursor, 8);
    }
    broadcast();
  });

  ipcMain.on('pet:menu', (e) => {
    const id = findDisplayId(e.sender);
    if (id === null) return;
    const win = windows.get(id);
    Menu.buildFromTemplate([{ label: '종료', click: () => app.quit() }]).popup({ window: win });
  });

  // --- 시작 ---

  // 디버그용: AIPET_START_DISPLAY=<인덱스>로 시작 모니터 지정
  const startIdx = Number(process.env.AIPET_START_DISPLAY);
  const startDisplay =
    debug && Number.isInteger(startIdx) && screen.getAllDisplays()[startIdx]
      ? screen.getAllDisplays()[startIdx]
      : screen.getPrimaryDisplay();
  const wa = startDisplay.workArea;
  pet.display = startDisplay.id;
  pet.x = wa.x + wa.width / 2;
  pet.y = wa.y + wa.height; // 작업표시줄 바로 위

  screen.on('display-added', syncDisplays);
  screen.on('display-removed', syncDisplays);
  screen.on('display-metrics-changed', syncDisplays);

  syncDisplays();
}
