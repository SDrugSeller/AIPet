// @ts-check
import { BrowserWindow, Menu, app, ipcMain, powerMonitor, screen, shell } from 'electron';
import { bodyMetrics, computePerch } from './perch.js';
import { createPetEngine } from './petEngine.js';
import { createNotifier } from './spontaneous.js';
import { createWindowWatcher } from './windowWatcher.js';
import { createAgentHost } from './agent/agentHost.js';
import { createClaudeCodeAdapter } from './agent/claudeCodeAdapter.js';
import { createOpenAICompatAdapter } from './agent/openaiCompatAdapter.js';

/**
 * 모니터마다 투명 오버레이 창을 하나씩 만든다.
 * 펫은 항상 한 모니터에만 속하고 그 모니터의 창에서만 그려진다
 * (배율이 다른 모니터 사이의 DIP 좌표는 경계에서 끊어지므로 경계에 걸쳐 그리지 않는다).
 * 펫의 행동/위치는 petEngine이 관리하고, 여기서는 창과 IPC, 드래그 입력을 맡는다.
 *
 * @param {{
 *   skin: any,
 *   preloadPath: string,
 *   rendererPath: string,
 *   debug: boolean,
 *   store: ReturnType<typeof import('./store.js').createStore>,
 *   config: ReturnType<typeof import('./config.js').createConfig>,
 *   getMenuTemplate: () => Electron.MenuItemConstructorOptions[],
 * }} opts
 */
export function createOverlayManager({ skin, preloadPath, rendererPath, debug, store, config, getMenuTemplate }) {
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

  // 에이전트 백엔드. 설정은 매번 config에서 읽으므로 설정 화면에서 바꾸면 바로 반영된다.
  /** 대화창을 열 때 키보드 포커스를 가져와도 되는가 (권한 요청으로 자동으로 열린 경우는 아님) */
  let chatFocus = true;
  const host = createAgentHost({
    adapters: [
      createClaudeCodeAdapter({ getConfig: () => config.claude(), metaDir: config.metaDir }),
      createOpenAICompatAdapter({ getConfig: () => config.openai() }),
    ],
    engine,
    broadcast: sendAll,
    onOpenChange: (open, { focus }) => {
      chatFocus = focus;
      if (open) hideNotice();
      syncChatFocus();
    },
    // 대화창을 닫아 둔 사이 응답이 끝났다. 완료 모션(done)이 보이도록 잠깐 뒤에 알린다.
    onTaskFinished: (r) => setTimeout(() => notifier.onTaskDone(r), 1000),
    isEnabled: (id) => config.isEnabled(id),
    getPolicy: () => config.policy(),
    notify: () => {
      if (store.get().general.sound) shell.beep();
    },
    onSelect: (id) => store.update({ backend: { selected: id } }),
    preferred: process.env.AIPET_BACKEND || store.get().backend.selected,
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
      const want = open && chatFocus && id === pet.display;
      win.setFocusable(want);
      if (want) {
        win.focus();
        focusDisplay = id;
      }
    }
    if (!open || !chatFocus) focusDisplay = 0;
  }

  // 펫 표시/숨김 (트레이에서 전환)
  let visible = store.get().general.visible;
  /** 전체화면 앱이 활성이라 잠시 숨겨 둔 상태 (사용자가 정한 visible 설정과는 별개) */
  let suspended = false;

  // --- 알림 말풍선 (자발적 발화) ---
  /** 전체화면 앱/발표 중인가: 이때는 먼저 말을 걸지 않는다 */
  const quiet = { fullscreen: false };
  let noticeActive = false;
  /** @type {NodeJS.Timeout | null} */
  let noticeTimer = null;

  /** @param {{ text: string, kind: string }} n */
  function showNotice({ text, kind }) {
    if (host.isOpen) return; // 이미 대화창이 열려 있다
    noticeActive = true;
    sendAll('notice:show', { text, kind });
    engine.setAgentAnim('attention'); // 펫이 알림을 알린다
    if (kind !== 'done' && store.get().general.sound) shell.beep(); // 사용자가 시킨 일의 결과는 조용히, 먼저 거는 말에는 소리
    if (noticeTimer) clearTimeout(noticeTimer);
    noticeTimer = setTimeout(hideNotice, 12_000);
  }

  function hideNotice() {
    if (!noticeActive) return;
    noticeActive = false;
    if (noticeTimer) clearTimeout(noticeTimer);
    noticeTimer = null;
    sendAll('notice:hide', null);
    if (!host.snapshot().busy) engine.setAgentAnim(null);
  }

  const notifier = createNotifier({
    getSettings: () => store.get().spontaneous,
    getQuiet: () => ({
      dnd: store.get().general.doNotDisturb,
      fullscreen: quiet.fullscreen,
      chatActive: host.isOpen || host.snapshot().busy,
      hidden: !visible || suspended,
    }),
    idleSeconds: () => powerMonitor.getSystemIdleTime(),
    show: showNotice,
  });

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
    if (host.isOpen && chatFocus && focusDisplay !== pet.display) syncChatFocus();
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
      if (visible && !suspended) win.showInactive();
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
    applyForeground();
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
  // 권한 요청으로 자동으로 열린 말풍선에서 사용자가 입력창을 눌렀다: 이제 키보드 포커스를 준다.
  ipcMain.on('chat:focus', (e) => {
    if (!fromOverlay(e) || !host.isOpen) return;
    chatFocus = true;
    syncChatFocus();
  });
  ipcMain.on('notice:action', (e, action) => {
    if (!fromOverlay(e)) return;
    hideNotice();
    if (action === 'open') host.setOpen(true); // "대화하기"
  });
  ipcMain.on('perm:respond', (e, id, allow) => {
    if (fromOverlay(e) && typeof id === 'string' && typeof allow === 'boolean') host.respondPermission(id, allow);
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
    Menu.buildFromTemplate(getMenuTemplate()).popup({ window: win });
  });

  /** 모든 오버레이 창을 보이거나 숨긴다. */
  function applyVisibility() {
    const show = visible && !suspended;
    for (const win of windows.values()) {
      if (win.isDestroyed()) continue;
      if (show) win.showInactive();
      else win.hide();
    }
  }

  /** @param {boolean} value */
  function setVisible(value) {
    visible = value;
    if (!value) host.setOpen(false);
    applyVisibility();
    store.update({ general: { visible: value } });
  }

  /** @param {boolean} value */
  function setSuspended(value) {
    if (suspended === value) return;
    suspended = value;
    if (value) {
      host.setOpen(false);
      hideNotice();
    }
    applyVisibility();
  }

  // --- 활성 창 인식 ---

  /** 가장 최근에 받은 활성 창 정보 (물리 픽셀) */
  /** @type {import('./windowWatcher.js').ForegroundInfo | null} */
  let foreground = null;
  const metrics = bodyMetrics(skin);

  /** 활성 창 정보로 "전체화면이라 숨길지", "올라갈 수 있는 창인지"를 판단해 반영한다. */
  function applyForeground() {
    const info = foreground;
    const s = store.get();
    quiet.fullscreen = !!info && (info.fs === 1 || info.busy === 1);
    setSuspended(s.behavior.hideOnFullscreen && !!info && info.fs === 1);

    /** @type {import('./perch.js').Perch | null} */
    let perch = null;
    if (s.behavior.sitOnWindows && !suspended && info && !info.none && info.hwnd) {
      // 도우미는 물리 픽셀을 주므로 Electron의 DIP 좌표로 바꾼다 (모니터마다 배율이 다를 수 있다).
      const rect = screen.screenToDipRect(null, { x: info.x ?? 0, y: info.y ?? 0, width: info.w ?? 0, height: info.h ?? 0 });
      perch = computePerch(
        { id: info.hwnd, rect, minimized: !!info.min, maximized: !!info.max, fullscreen: info.fs === 1 },
        screen.getAllDisplays(),
        metrics,
      );
      if (debug) console.log('[window]', info.proc, JSON.stringify(rect), '→', perch ? `올라갈 수 있음 top=${perch.top} display=${perch.display}` : '올라갈 수 없음');
    }
    engine.setTarget(perch);
  }

  const watcher = createWindowWatcher({
    onChange: (info) => {
      if (debug) console.log('[watch] 활성 창', info.proc ?? '(없음)', info.cls ?? '', info.fs ? 'fullscreen' : '', info.busy ? 'busy' : '');
      foreground = info;
      applyForeground();
    },
    onLog: (msg) => debug && console.log('[watch]', msg),
  });
  store.onChange(applyForeground); // 설정(올라가기/전체화면 숨김)이 바뀌면 바로 반영

  const tickMs = (debug && Number(process.env.AIPET_NOTIFY_TICK_MS)) || 30_000;
  const tickTimer = setInterval(() => notifier.tick(), tickMs);

  app.on('before-quit', () => {
    host.dispose();
    watcher.stop();
    clearInterval(tickTimer);
  });

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

  // 디버그용: AIPET_FAKE_WINDOW="x,y,w,h"(물리 픽셀)를 주면 실제 창 대신 그런 활성 창이 있는 것처럼 동작한다.
  // 사용자의 실제 창이나 포커스를 건드리지 않고 올라가기 흐름을 검증할 수 있다.
  const fake = debug ? process.env.AIPET_FAKE_WINDOW?.split(',').map(Number) : null;
  if (fake && fake.length === 4 && fake.every(Number.isFinite)) {
    foreground = { hwnd: 'fake', pid: 0, proc: 'fake', cls: 'fake', x: fake[0], y: fake[1], w: fake[2], h: fake[3], min: 0, max: 0, fs: 0, busy: 0 };
    applyForeground();
  } else {
    watcher.start();
  }

  // 디버그용: AIPET_TEST_NOTICE="문구"를 주면 3초 뒤 알림 말풍선을 띄운다.
  if (debug && process.env.AIPET_TEST_NOTICE) {
    setTimeout(() => showNotice({ text: /** @type {string} */ (process.env.AIPET_TEST_NOTICE), kind: 'reminder' }), 3000);
  }

  // 디버그용: AIPET_AUTOTEST_MSG를 주면 시작 후 대화창을 열고 그 메시지를 보낸다.
  if (debug && process.env.AIPET_AUTOTEST_MSG) {
    setTimeout(() => {
      host.setOpen(true);
      void host.send(/** @type {string} */ (process.env.AIPET_AUTOTEST_MSG));
    }, 2500);
  }

  return {
    host,
    engine,
    isVisible: () => visible,
    setVisible,
  };
}
