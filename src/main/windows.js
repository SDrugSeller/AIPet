// @ts-check
import { BrowserWindow, Menu, app, ipcMain, screen } from 'electron';
import { createPetEngine } from './petEngine.js';
import { createAgentHost } from './agent/agentHost.js';
import { createClaudeCodeAdapter } from './agent/claudeCodeAdapter.js';
import { createOpenAICompatAdapter } from './agent/openaiCompatAdapter.js';

/**
 * 모니터마다 투명 오버레이 창을 하나씩 만든다.
 * 펫은 항상 한 모니터에만 속하고 그 모니터의 창에서만 그려진다
 * (배율이 다른 모니터 사이의 DIP 좌표는 경계에서 끊어지므로 경계에 걸쳐 그리지 않는다).
 * 펫의 행동/위치는 petEngine이 관리하고, 여기서는 창과 IPC, 드래그 입력을 맡는다.
 *
 * @param {{ skin: any, preloadPath: string, rendererPath: string, workDir: string, debug: boolean }} opts
 */
export function createOverlayManager({ skin, preloadPath, rendererPath, workDir, debug }) {
  /** @type {Map<number, BrowserWindow>} displayId → 오버레이 창 */
  const windows = new Map();
  const headroom = skin.anchor.y * skin.scale;
  const halfLeft = skin.anchor.x * skin.scale;
  const halfRight = (skin.frameSize.w - skin.anchor.x) * skin.scale;

  const sleepSec = Number(process.env.AIPET_SLEEP_AFTER_SEC);
  const engine = createPetEngine({
    skin,
    area: areaOf,
    emit: broadcast,
    sleepAfterMs: (debug && sleepSec > 0 ? sleepSec : 60) * 1000,
  });
  const pet = engine.pet;

  // 에이전트 백엔드 (M3: Claude Code CLI + OpenAI 호환). 설정 저장은 M4에서 추가한다.
  const env = process.env;
  const host = createAgentHost({
    adapters: [
      createClaudeCodeAdapter({ workDir }),
      createOpenAICompatAdapter({
        baseUrl: env.AIPET_OPENAI_BASE_URL || 'http://127.0.0.1:11434/v1',
        model: env.AIPET_OPENAI_MODEL || undefined,
        apiKey: env.AIPET_OPENAI_KEY || undefined,
      }),
    ],
    engine,
    broadcast: sendAll,
    onOpenChange: syncChatFocus,
    preferred: env.AIPET_BACKEND || undefined,
  });

  /** @param {string} channel @param {any} payload */
  function sendAll(channel, payload) {
    for (const win of windows.values()) {
      if (!win.isDestroyed()) win.webContents.send(channel, payload);
    }
  }

  /** 대화창이 열려 있는 동안만, 펫이 있는 모니터의 창이 키보드 포커스를 받는다. */
  let focusDisplay = 0;
  function syncChatFocus() {
    const open = host.isOpen;
    for (const [id, win] of windows) {
      if (win.isDestroyed()) continue;
      const want = open && id === pet.display;
      win.setFocusable(want);
      if (want) {
        win.focus();
        focusDisplay = id;
      }
    }
    if (!open) focusDisplay = 0;
  }

  /** 펫이 서 있을 수 있는 영역: 작업 영역(작업표시줄 제외) 안에서 몸 전체가 보이는 범위 */
  /** @param {number} displayId */
  function areaOf(displayId) {
    const d = screen.getAllDisplays().find((x) => x.id === displayId);
    if (!d) return null;
    const wa = d.workArea;
    return {
      left: wa.x + halfLeft,
      right: Math.max(wa.x + halfLeft, wa.x + wa.width - halfRight),
      ground: wa.y + wa.height,
    };
  }

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

  /** 펫(발 위치 기준)을 자기 모니터 안으로 제한한다. 모니터가 사라졌으면 가까운 모니터로 옮긴다. */
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
    if (debug && !pet.dragging) {
      console.log('[pet]', pet.anim, pet.facing, `display=${pet.display}`, `x=${Math.round(pet.x)}`, `y=${Math.round(pet.y)}`, pet.move ? JSON.stringify(pet.move) : '');
    }
    sendAll('pet:state', { ...pet });
    // 대화창이 열린 채 펫이 다른 모니터로 가면 포커스도 따라간다.
    if (host.isOpen && focusDisplay !== pet.display) syncChatFocus();
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
        backgroundThrottling: false, // 가려진 창으로 판단돼도 애니메이션이 멈추지 않게
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
        win.once('show', () =>
          setTimeout(async () => {
            const img = await win.webContents.capturePage();
            const { writeFile } = await import('node:fs/promises');
            await writeFile(`${process.env.AIPET_CAPTURE_DIR}/window-${display.id}.png`, img.toPNG());
          }, Number(process.env.AIPET_CAPTURE_DELAY_MS) || 3000),
        );
      }
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
    engine.relayout(); // 바닥에 다시 세우고 broadcast
  }

  // --- IPC (화이트리스트 채널만, 보낸 쪽이 우리 오버레이 창인지 확인) ---

  ipcMain.handle('overlay:init', (e) => {
    const id = findDisplayId(e.sender);
    const bounds = id === null ? null : boundsOf(id);
    if (!bounds) throw new Error('알 수 없는 창');
    return { displayId: id, bounds, skin, pet: { ...pet }, chat: host.snapshot(), debug };
  });

  // --- 대화 (렌더러의 사용자 입력은 모두 여기서 검증 후 호스트로 전달) ---

  /** @param {Electron.IpcMainEvent} e */
  const fromOverlay = (e) => findDisplayId(e.sender) !== null;

  ipcMain.on('pet:click', (e) => {
    if (!fromOverlay(e)) return;
    engine.poke();
    host.setOpen(!host.isOpen);
  });
  ipcMain.on('chat:close', (e) => {
    if (fromOverlay(e)) host.setOpen(false);
  });
  ipcMain.on('chat:send', (e, text) => {
    if (fromOverlay(e) && typeof text === 'string') void host.send(text);
  });
  ipcMain.on('chat:abort', (e) => {
    if (fromOverlay(e)) host.abort();
  });

  ipcMain.on('overlay:set-interactive', (e, interactive) => {
    const id = findDisplayId(e.sender);
    if (id === null || typeof interactive !== 'boolean') return;
    windows.get(id)?.setIgnoreMouseEvents(!interactive, { forward: true });
  });

  // 드래그 중 좌표는 렌더러의 clientX/Y 대신 main의 커서 좌표를 쓴다.
  // 드래그를 시작한 창이 포인터를 계속 잡고 있는데, 그 창은 다른 모니터의 배율을 몰라
  // 배율이 다른 모니터로 넘어가면 clientX/Y가 어긋난다. getCursorScreenPoint는 모니터별 배율이 반영된 DIP 좌표다.
  /** @type {{ dx: number, dy: number } | null} */
  let grab = null;
  /** @type {NodeJS.Timeout | null} */
  let dragTimer = null;

  function followCursor() {
    if (!grab) return;
    const c = screen.getCursorScreenPoint();
    const before = { x: pet.x, y: pet.y, display: pet.display };
    // 펫은 커서가 있는 모니터로 옮겨 간다 (커서와 같은 모니터 좌표계에서 계산).
    pet.display = screen.getDisplayNearestPoint(c).id;
    pet.x = c.x + grab.dx;
    pet.y = c.y + grab.dy;
    clampPet();
    if (pet.x === before.x && pet.y === before.y && pet.display === before.display) return;
    broadcast();
  }

  function stopDragTimer() {
    if (dragTimer) clearInterval(dragTimer);
    dragTimer = null;
    grab = null;
  }

  ipcMain.on('pet:dragging', (e, dragging) => {
    if (findDisplayId(e.sender) === null || typeof dragging !== 'boolean') return;
    stopDragTimer();
    if (dragging) {
      engine.startDrag();
      const c = screen.getCursorScreenPoint();
      grab = { dx: pet.x - c.x, dy: pet.y - c.y };
      // 포인터 이벤트는 모니터 경계를 넘는 순간 끊길 수 있어, 이벤트 대신 타이머로 커서를 읽는다.
      dragTimer = setInterval(followCursor, 8);
    } else {
      engine.endDrag();
    }
  });

  ipcMain.on('pet:menu', (e) => {
    const id = findDisplayId(e.sender);
    if (id === null) return;
    const win = windows.get(id);
    void host.refresh(); // 다음에 메뉴를 열 때를 위해 최신 상태로 갱신
    Menu.buildFromTemplate([
      { label: 'AI 연결', enabled: false },
      ...host.backends().map((b) => ({
        label: `${b.label}${b.available ? '' : '  (사용 불가)'}`,
        type: /** @type {const} */ ('radio'),
        checked: b.selected,
        click: () => host.select(b.id),
      })),
      { label: '연결 다시 확인', click: () => void host.refresh() },
      { type: 'separator' },
      { label: '종료', click: () => app.quit() },
    ]).popup({ window: win });
  });

  app.on('before-quit', () => host.dispose());

  // --- 시작 ---

  // 디버그용: AIPET_START_DISPLAY=<인덱스>로 시작 모니터 지정
  const startIdx = Number(process.env.AIPET_START_DISPLAY);
  const startDisplay =
    debug && Number.isInteger(startIdx) && screen.getAllDisplays()[startIdx]
      ? screen.getAllDisplays()[startIdx]
      : screen.getPrimaryDisplay();
  const wa = startDisplay.workArea;

  screen.on('display-added', syncDisplays);
  screen.on('display-removed', syncDisplays);
  screen.on('display-metrics-changed', syncDisplays);

  engine.start(startDisplay.id, wa.x + wa.width / 2);
  syncDisplays();
  void host.refresh(); // 사용 가능한 AI 백엔드 탐지

  // 디버그용: AIPET_AUTOTEST_MSG를 주면 시작 후 대화창을 열고 그 메시지를 보낸다.
  if (debug && process.env.AIPET_AUTOTEST_MSG) {
    setTimeout(() => {
      host.setOpen(true);
      void host.send(/** @type {string} */ (process.env.AIPET_AUTOTEST_MSG));
    }, 2500);
  }
}
