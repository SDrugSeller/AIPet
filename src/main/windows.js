// @ts-check
import { BrowserWindow, Menu, app, ipcMain, powerMonitor, screen, shell } from 'electron';
import { KINDS } from '../shared/connections.js';
import { createAgentHost } from './agent/agentHost.js';
import { createAdapterFor } from './agent/factory.js';
import { bodyMetrics, computePerch } from './perch.js';
import { createPetEngine } from './petEngine.js';
import { needsSetupHint, SETUP_HINT_TEXT } from './setupHint.js';
import { createNotifier } from './spontaneous.js';
import { createWindowWatcher } from './windowWatcher.js';

/**
 * 연결(connection) 하나마다 펫 한 마리를 띄운다. 펫마다 자기 AI 어댑터, 스킨, 말투, 대화창, 행동 상태를 가진다.
 *
 * 화면에는 모니터마다 투명 오버레이 창을 하나씩 만들고, 모든 펫을 거기서 그린다.
 * 펫은 항상 한 모니터에만 속하고 그 모니터의 창에서만 그려진다
 * (배율이 다른 모니터 사이의 DIP 좌표는 경계에서 끊어지므로 경계에 걸쳐 그리지 않는다).
 *
 * @param {{
 *   preloadPath: string,
 *   rendererPath: string,
 *   debug: boolean,
 *   store: ReturnType<typeof import('./store.js').createStore>,
 *   config: ReturnType<typeof import('./config.js').createConfig>,
 *   loadSkin: (name: string, tuning?: any) => Promise<any>,
 *   getMenuTemplate: (petId?: string) => Electron.MenuItemConstructorOptions[],
 *   openSettings: (tab?: string) => void,
 * }} opts
 */
export function createOverlayManager({ preloadPath, rendererPath, debug, store, config, loadSkin, getMenuTemplate, openSettings }) {
  /** @type {Map<number, BrowserWindow>} displayId → 오버레이 창 */
  const windows = new Map();

  /**
   * @typedef {{
   *   id: string,
   *   conn: import('../shared/connections.js').Connection,
   *   skin: any,
   *   metrics: ReturnType<typeof bodyMetrics>,
   *   halfLeft: number, halfRight: number, headroom: number,
   *   engine: ReturnType<typeof createPetEngine>,
   *   host: ReturnType<typeof createAgentHost>,
   *   fingerprint: string,
   *   optionsKey: string,
   *   noticeActive: boolean,
   *   noticeInfo: { text: string, kind: string } | null,
   *   noticeTimer: NodeJS.Timeout | null,
   * }} Pet
   */
  /** @type {Map<string, Pet>} 연결 id → 펫 */
  const pets = new Map();

  const sleepSec = Number(process.env.AIPET_SLEEP_AFTER_SEC);
  const sleepAfterMs = (debug && sleepSec > 0 ? sleepSec : 60) * 1000;

  // 디버그 전용: 마우스 이동 전달(forward)을 끄면 Windows가 전역 마우스 훅을 조용히 제거한 상황과 같아진다.
  const noForward = debug && process.env.AIPET_NO_FORWARD === '1';
  const noCursorPoll = debug && process.env.AIPET_NO_CURSOR_POLL === '1';
  /** 클릭 통과 상태를 바꾼다. 통과 중에도 펫 위 마우스를 알 수 있도록 이동 이벤트 전달(forward)을 켠다. @param {Electron.BrowserWindow} win @param {boolean} ignore */
  const setClickThrough = (win, ignore) => win.setIgnoreMouseEvents(ignore, ignore && !noForward ? { forward: true } : undefined);

  /** @param {string} channel @param {any} payload */
  function sendAll(channel, payload) {
    for (const win of windows.values()) {
      if (!win.isDestroyed()) win.webContents.send(channel, payload);
    }
  }

  // 펫 표시/숨김 (트레이에서 전환)
  let visible = store.get().general.visible;
  /** 전체화면 앱이 활성이라 잠시 숨겨 둔 상태 (사용자가 정한 visible 설정과는 별개) */
  let suspended = false;
  /** 창을 hide()한 적이 있는가: 다시 보일 때 새 창으로 바꿔야 한다 (applyVisibility 참조) */
  let windowsWereHidden = false;
  /** 전체화면 앱/발표 중인가: 이때는 먼저 말을 걸지 않는다 */
  const quiet = { fullscreen: false };

  // --- 펫 한 마리의 도우미들 ---

  /** 펫이 서 있을 수 있는 영역: 작업 영역(작업표시줄 제외) 안에서 몸 전체가 보이는 범위 @param {Pet} pet @param {number} displayId */
  function areaOf(pet, displayId) {
    const d = screen.getAllDisplays().find((x) => x.id === displayId);
    if (!d) return null;
    const wa = d.workArea;
    return {
      left: wa.x + pet.halfLeft,
      right: Math.max(wa.x + pet.halfLeft, wa.x + wa.width - pet.halfRight),
      ground: wa.y + wa.height,
    };
  }

  /** 드래그 중인 펫(발 위치 기준)을 자기 모니터 안으로 제한한다. 모니터가 사라졌으면 가까운 모니터로 옮긴다. @param {Pet} pet */
  function clampPet(pet) {
    const p = pet.engine.pet;
    const d =
      screen.getAllDisplays().find((x) => x.id === p.display) ??
      screen.getDisplayNearestPoint({ x: Math.round(p.x), y: Math.round(p.y) });
    const b = d.bounds;
    p.display = d.id;
    p.x = Math.min(Math.max(p.x, b.x + pet.halfLeft), b.x + b.width - pet.halfRight);
    p.y = Math.min(Math.max(p.y, b.y + pet.headroom), b.y + b.height);
  }

  /** 렌더러에 보낼 펫 한 마리의 정보 @param {Pet} pet */
  function descriptor(pet) {
    return {
      id: pet.id,
      name: pet.conn.name,
      kind: pet.conn.kind,
      kindLabel: KINDS[pet.conn.kind].label,
      skin: pet.skin,
      state: { ...pet.engine.pet },
      chat: pet.host.snapshot(),
      notice: pet.noticeInfo,
    };
  }

  /** 펫 목록(추가/삭제/이름 변경)을 모든 창에 알린다. */
  function broadcastPets() {
    sendAll('pets:sync', [...pets.values()].map(descriptor));
  }

  // --- 키보드 포커스: 대화창 입력은 "마지막으로 입력을 요청한 펫"이 있는 모니터의 창이 받는다 ---

  /** @type {string | null} */
  let focusPetId = null;
  let focusDisplay = 0;

  /** 펫을 끄는 중에 미룬 포커스 맞추기가 있는가 (드래그가 끝나면 한 번 한다) */
  let focusSyncPending = false;

  /**
   * 열려 있는 대화창이 있는 모니터의 창만 키보드 포커스를 받게 맞춘다.
   *  - 버튼을 누르고 끄는 동안에는 하지 않는다. 마우스를 잡고 있는 창이 포커스를 잃으면 마우스 캡처가 풀려서 드래그가 끊긴다
   *    (펫이 다른 모니터로 넘어갈 때 실제로 그랬다). 끝난 뒤에 맞춘다.
   *  - 다른 창들을 먼저 포커스 불가로 바꾸고, 대상 창을 마지막에 처리한다. 대상 창에 포커스를 준 뒤에 다른 창을 바꾸면
   *    Windows가 다음 창으로 활성화를 넘기면서 방금 준 포커스를 도로 빼앗았다 ("잠깐 갔다가 즉시 돌아가는" 증상).
   *  - 이미 그 상태인 창은 건드리지 않는다 (불필요한 호출이 활성화를 흔든다).
   */
  function syncChatFocus() {
    if (drag) {
      focusSyncPending = true;
      return;
    }
    focusSyncPending = false;
    const target = focusPetId ? pets.get(focusPetId) : null;
    const want = target && target.host.isOpen ? target.engine.pet.display : 0;
    if (debug) console.log('[focus] sync want=', want, 'prev=', focusDisplay, 'order=', [...windows.keys()].join(','));
    for (const [id, win] of windows) {
      if (win.isDestroyed() || id === want) continue;
      if (win.isFocusable()) win.setFocusable(false);
    }
    const win = want !== 0 ? windows.get(want) : null;
    if (win && !win.isDestroyed()) {
      if (!win.isFocusable()) win.setFocusable(true);
      if (!win.isFocused()) win.focus();
    }
    focusDisplay = want;
  }

  // --- 알림 말풍선 (자발적 발화) ---

  /** @param {string} petId @param {{ text: string, kind: string }} n */
  function showNotice(petId, { text, kind }) {
    const pet = pets.get(petId);
    if (!pet || pet.host.isOpen) return; // 이미 대화창이 열려 있다
    pet.noticeActive = true;
    pet.noticeInfo = { text, kind }; // 아직 열리지 않은 창이 나중에 열려도 지금 떠 있는 알림을 받도록 기억해 둔다
    sendAll('notice:show', { petId, text, kind });
    // 설정 안내(setup)는 조용히 보여 주고 더 오래 둔다. 나머지는 펫이 알림을 알리고(소리 포함) 12초 뒤에 사라진다.
    if (kind !== 'setup') {
      pet.engine.setAgentAnim('attention');
      if (kind !== 'done' && store.get().general.sound) shell.beep(); // 사용자가 시킨 일의 결과는 조용히, 먼저 거는 말에는 소리
    }
    if (pet.noticeTimer) clearTimeout(pet.noticeTimer);
    pet.noticeTimer = setTimeout(() => hideNotice(petId), kind === 'setup' ? 25_000 : 12_000);
  }

  /** @param {string} petId */
  function hideNotice(petId) {
    const pet = pets.get(petId);
    if (!pet || !pet.noticeActive) return;
    pet.noticeActive = false;
    pet.noticeInfo = null;
    if (pet.noticeTimer) clearTimeout(pet.noticeTimer);
    pet.noticeTimer = null;
    sendAll('notice:hide', { petId });
    if (!pet.host.snapshot().busy) pet.engine.setAgentAnim(null);
  }

  /** 먼저 말을 거는 펫: 목록의 첫 번째 펫 */
  const primaryPetId = () => [...pets.keys()][0];

  const anyChatActive = () => [...pets.values()].some((p) => p.host.isOpen || p.host.snapshot().busy);

  const notifier = createNotifier({
    getSettings: () => store.get().spontaneous,
    getQuiet: () => ({
      dnd: store.get().general.doNotDisturb,
      fullscreen: quiet.fullscreen,
      chatActive: anyChatActive(),
      hidden: !visible || suspended,
    }),
    idleSeconds: () => powerMonitor.getSystemIdleTime(),
    show: ({ text, kind, petId }) => {
      const id = petId ?? primaryPetId();
      if (id) showNotice(id, { text, kind });
    },
  });

  // --- 펫 추가/삭제 ---

  /** 상태 변화(점검 결과)를 구독자(설정 창)에게 알린다 */
  /** @type {Set<() => void>} */
  const statusListeners = new Set();
  const emitStatus = () => statusListeners.forEach((cb) => cb());

  // --- 첫 실행 안내: 쓸 수 있는 연결이 하나도 없으면 첫 번째 펫이 설정을 안내한다 (실행마다 한 번) ---

  let setupHintShown = false;
  /** 안내 말풍선이 떠 있는 펫 id */
  /** @type {string | null} */
  let setupHintPetId = null;

  function updateSetupHint() {
    const list = [...pets.values()].map((p) => {
      const b = p.host.backends()[0];
      return { checked: !!b?.checked, available: !!b?.available };
    });
    if (setupHintPetId && !needsSetupHint(list)) {
      // 그 사이 연결이 생겼다 (CLI를 설치/로그인했다): 안내를 거둔다
      const id = setupHintPetId;
      setupHintPetId = null;
      hideNotice(id);
      return;
    }
    if (setupHintShown || !needsSetupHint(list)) return;
    // 방해하면 안 되는 때에는 미루고 다음 점검 때 다시 본다 (보여 줬다고 치지 않는다)
    if (!visible || suspended || quiet.fullscreen || store.get().general.doNotDisturb) return;
    const id = primaryPetId();
    if (!id) return;
    setupHintShown = true;
    setupHintPetId = id;
    showNotice(id, { text: SETUP_HINT_TEXT, kind: 'setup' });
  }

  /** @param {Pet} pet */
  async function refreshPet(pet) {
    await pet.host.refresh();
    emitStatus();
    updateSetupHint();
  }

  /** @param {import('../shared/connections.js').Connection} conn @param {import('./store.js').Settings['skinTuning']} tuning */
  const fingerprintOf = (conn, tuning) => JSON.stringify([conn.kind, conn.skin, tuning[conn.skin] ?? null]);

  /**
   * @param {import('../shared/connections.js').Connection} conn
   * @param {{ display?: number, x?: number }} [hint]  다시 만들 때 있던 자리를 이어받는다
   */
  async function addPet(conn, hint = {}) {
    const tuning = store.get().skinTuning;
    let skin;
    try {
      skin = await loadSkin(conn.skin, tuning[conn.skin]);
    } catch (e) {
      console.error(`스킨 '${conn.skin}'을 불러오지 못해 기본 스킨을 씁니다:`, /** @type {Error} */ (e).message);
      skin = await loadSkin('default', tuning.default);
    }
    // 스킨을 읽는 사이에 연결이 지워졌거나 이미 만들어졌으면 그만둔다.
    if (pets.has(conn.id) || !store.get().connections.some((c) => c.id === conn.id && c.enabled)) return;

    const metrics = bodyMetrics(skin);
    /** @type {Pet} */
    const pet = /** @type {any} */ ({
      id: conn.id,
      conn,
      skin,
      metrics,
      halfLeft: skin.anchor.x * skin.scale,
      halfRight: (skin.frameSize.w - skin.anchor.x) * skin.scale,
      headroom: skin.anchor.y * skin.scale,
      fingerprint: fingerprintOf(conn, tuning),
      optionsKey: JSON.stringify([conn.options, conn.persona]),
      noticeActive: false,
      noticeInfo: null,
      noticeTimer: null,
    });

    pet.engine = createPetEngine({
      skin,
      area: (displayId) => areaOf(pet, displayId),
      emit: () => {
        const p = pet.engine.pet;
        if (debug && !p.dragging) {
          console.log('[pet]', pet.id, p.anim, p.facing, `display=${p.display}`, `x=${Math.round(p.x)}`, `y=${Math.round(p.y)}`, p.move ? JSON.stringify(p.move) : '');
        }
        sendAll('pet:state', { id: pet.id, ...p });
        // 대화창이 열린 채 펫이 다른 모니터로 가면 키보드 포커스도 따라간다.
        if (focusPetId === pet.id && pet.host.isOpen && focusDisplay !== p.display) syncChatFocus();
      },
      sleepAfterMs,
    });

    const adapter = createAdapterFor(conn, { config, metaDir: config.metaDir });
    pet.host = createAgentHost({
      adapters: [adapter],
      engine: pet.engine,
      // 이 펫의 대화/권한 이벤트에는 petId를 붙여서 렌더러가 해당 펫의 말풍선으로 보낸다.
      broadcast: (channel, payload) => sendAll(channel, { petId: pet.id, ...payload }),
      onOpenChange: (open, { focus }) => {
        if (open) {
          hideNotice(pet.id);
          if (focus) focusPetId = pet.id;
        } else if (focusPetId === pet.id) {
          focusPetId = null;
        }
        syncChatFocus();
      },
      isEnabled: () => true,
      getPolicy: () => config.policy(),
      notify: () => {
        if (store.get().general.sound) shell.beep();
      },
      // 대화창을 닫아 둔 사이 응답이 끝났다. 완료 모션(done)이 보이도록 잠깐 뒤에 이 펫이 알린다.
      onTaskFinished: (r) => setTimeout(() => notifier.onTaskDone({ ...r, petId: pet.id }), 1000),
    });

    pets.set(conn.id, pet);

    // 시작 위치: 이어받은 자리가 없으면 기본 모니터의 바닥에 가로로 고르게 놓는다.
    const startIdx = Number(process.env.AIPET_START_DISPLAY);
    const displays = screen.getAllDisplays();
    const startDisplay =
      displays.find((d) => d.id === hint.display) ??
      (debug && Number.isInteger(startIdx) && displays[startIdx] ? displays[startIdx] : screen.getPrimaryDisplay());
    const wa = startDisplay.workArea;
    const order = [...pets.keys()].indexOf(conn.id);
    const total = Math.max(1, store.get().connections.filter((c) => c.enabled).length);
    const x = hint.x ?? wa.x + (wa.width * (order + 1)) / (total + 1);
    pet.engine.start(startDisplay.id, x);

    void refreshPet(pet);
    applyForeground();
  }

  /** @param {string} id */
  function removePet(id) {
    const pet = pets.get(id);
    if (!pet) return;
    pet.host.dispose();
    pet.engine.dispose();
    if (pet.noticeTimer) clearTimeout(pet.noticeTimer);
    if (drag?.petId === id) stopDrag();
    if (focusPetId === id) focusPetId = null;
    pets.delete(id);
    syncChatFocus();
  }

  /**
   * 설정의 연결 목록과 실제 펫을 맞춘다: 새 연결은 펫을 만들고, 사라지거나 꺼진 연결은 펫을 없애고,
   * 스킨/종류가 바뀐 연결은 펫을 다시 만든다(자리는 이어받는다). 비동기 작업이라 순서대로 하나씩 처리한다.
   */
  let syncChain = Promise.resolve();
  function syncPets() {
    syncChain = syncChain.then(doSyncPets).catch((e) => console.error('[sync]', e));
    return syncChain;
  }

  async function doSyncPets() {
    const s = store.get();
    const want = s.connections.filter((c) => c.enabled);
    const wantIds = new Set(want.map((c) => c.id));
    for (const id of [...pets.keys()]) if (!wantIds.has(id)) removePet(id);

    for (const conn of want) {
      const pet = pets.get(conn.id);
      if (!pet) {
        await addPet(conn);
      } else if (pet.fingerprint !== fingerprintOf(conn, s.skinTuning)) {
        const p = pet.engine.pet;
        removePet(conn.id);
        await addPet(conn, { display: p.display, x: p.x });
      } else {
        const optionsKey = JSON.stringify([conn.options, conn.persona]);
        pet.conn = conn; // 이름/옵션/말투는 어댑터가 호출할 때마다 설정에서 읽으므로 바로 반영된다
        if (optionsKey !== pet.optionsKey) {
          pet.optionsKey = optionsKey;
          if (pet.host.snapshot().busy === false) void refreshPet(pet); // 경로/주소/키가 바뀌었을 수 있으니 다시 점검
        }
      }
    }
    broadcastPets();
    emitStatus();
  }

  // --- 창 ---

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
      focusable: false, // 클릭해도 다른 앱의 포커스를 빼앗지 않는다 (대화창을 열 때만 잠시 포커스를 준다)
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
    setClickThrough(win, true); // 기본은 클릭 통과
    cursorSent.delete(display.id);
    if (debug) {
      win.on('focus', () => console.log('[focus] window', display.id, 'GOT focus'));
      win.on('blur', () => console.log('[focus] window', display.id, 'LOST focus'));
    }
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.on('will-navigate', (e) => e.preventDefault());
    win.once('ready-to-show', () => {
      applyBounds(win, display.bounds);
      if (visible && !suspended) win.showInactive();
    });
    if (debug) {
      win.webContents.on('console-message', (e) => console.log(`[renderer ${display.id}]`, e.message));
      win.webContents.on('did-fail-load', (_e, code, desc) => console.log(`[load fail ${display.id}]`, code, desc));
      // AIPET_CAPTURE_DIR 지정 시 몇 초 뒤 각 창의 렌더링 결과를 PNG로 저장 (검증용)
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
    for (const pet of pets.values()) {
      clampPet(pet);
      pet.engine.relayout(); // 바닥에 다시 세우고 알림
    }
    applyForeground();
  }

  // --- IPC (화이트리스트 채널만, 보낸 쪽이 우리 오버레이 창인지, 펫 id가 있는지 확인) ---

  /** @param {Electron.IpcMainEvent} e */
  const fromOverlay = (e) => findDisplayId(e.sender) !== null;
  /** 오버레이에서 온 요청이면 대상 펫을 돌려준다. @param {Electron.IpcMainEvent} e @param {unknown} petId */
  const petOf = (e, petId) => (fromOverlay(e) && typeof petId === 'string' ? (pets.get(petId) ?? null) : null);

  ipcMain.handle('overlay:init', (e) => {
    const id = findDisplayId(e.sender);
    const bounds = id === null ? null : boundsOf(id);
    if (!bounds) throw new Error('알 수 없는 창');
    return { displayId: id, bounds, pets: [...pets.values()].map(descriptor), debug };
  });

  ipcMain.on('pet:click', (e, petId) => {
    const pet = petOf(e, petId);
    if (!pet) return;
    if (debug) console.log('[pet:click]', pet.id);
    pet.engine.poke();
    pet.host.setOpen(!pet.host.isOpen);
  });
  ipcMain.on('chat:close', (e, petId) => petOf(e, petId)?.host.setOpen(false));
  ipcMain.on('chat:new', (e, petId) => petOf(e, petId)?.host.newSession());
  ipcMain.on('chat:send', (e, petId, text) => {
    if (typeof text === 'string') void petOf(e, petId)?.host.send(text);
  });
  ipcMain.on('chat:abort', (e, petId) => petOf(e, petId)?.host.abort());
  // 권한 요청으로 자동으로 열린 말풍선에서 사용자가 입력창을 눌렀다: 이제 이 펫이 키보드 포커스를 받는다.
  ipcMain.on('chat:focus', (e, petId) => {
    const pet = petOf(e, petId);
    if (!pet || !pet.host.isOpen) return;
    focusPetId = pet.id;
    if (debug) {
      // 입력칸 클릭과 그 뒤의 포커스 결과를 짝지어 남긴다 (none이면 포커스가 앱 밖의 다른 창에 있다)
      const owner = () => (BrowserWindow.getFocusedWindow() ? `overlay ${findDisplayId(BrowserWindow.getFocusedWindow()?.webContents ?? e.sender)}` : 'none(다른 앱)');
      const win = windows.get(findDisplayId(e.sender) ?? -1);
      console.log('[focus] 입력칸 클릭: 클릭한 창 isFocused=', win?.isFocused(), '현재 포커스=', owner());
      for (const ms of [150, 600]) setTimeout(() => console.log(`[focus] 입력칸 클릭 +${ms}ms: 포커스=`, owner()), ms);
    }
    syncChatFocus();
  });
  ipcMain.on('notice:action', (e, petId, action) => {
    const pet = petOf(e, petId);
    if (!pet) return;
    hideNotice(pet.id);
    if (action === 'open') pet.host.setOpen(true); // "대화하기"
    if (action === 'settings') openSettings('ai'); // "설정 열기" (설정 안내 말풍선)
  });
  ipcMain.on('perm:respond', (e, petId, id, allow) => {
    if (typeof id === 'string' && typeof allow === 'boolean') petOf(e, petId)?.host.respondPermission(id, allow);
  });

  ipcMain.on('overlay:set-interactive', (e, interactive) => {
    const id = findDisplayId(e.sender);
    if (id === null || typeof interactive !== 'boolean') return;
    const win = windows.get(id);
    if (win && !win.isDestroyed()) setClickThrough(win, !interactive);
  });

  // 드래그 중 좌표는 렌더러의 clientX/Y 대신 main의 커서 좌표를 쓴다.
  // 드래그를 시작한 창이 포인터를 계속 잡고 있는데, 그 창은 다른 모니터의 배율을 몰라
  // 배율이 다른 모니터로 넘어가면 clientX/Y가 어긋난다. getCursorScreenPoint는 모니터별 배율이 반영된 DIP 좌표다.
  /** 한 번에 한 마리만 드래그할 수 있다 @type {{ petId: string, dx: number, dy: number, timer: NodeJS.Timeout } | null} */
  let drag = null;

  // 디버그 전용: 드래그가 어떻게 이어지고 끝나는지(또는 끝나지 않는지) 기록한다.
  let dragLogAt = 0;
  let dragOutsideLogged = false;
  /** @param {Electron.Point} c @param {{ x: number, y: number, display: number }} p */
  function dragDiag(c, p) {
    const now = Date.now();
    const inside = screen.getAllDisplays().some((d) => c.x >= d.bounds.x && c.x < d.bounds.x + d.bounds.width && c.y >= d.bounds.y && c.y < d.bounds.y + d.bounds.height);
    if (!inside && !dragOutsideLogged) {
      dragOutsideLogged = true;
      console.log('[drag] 커서가 모든 모니터 범위 밖', JSON.stringify(c), '→ 가까운 모니터', screen.getDisplayNearestPoint(c).id);
    } else if (inside) {
      dragOutsideLogged = false;
    }
    if (now - dragLogAt > 2000) {
      dragLogAt = now;
      console.log('[drag] 따라가는 중', `cursor=${c.x},${c.y}`, `pet=${Math.round(p.x)},${Math.round(p.y)}`, `display=${p.display}`);
    }
  }

  function followCursor() {
    if (!drag) return;
    const pet = pets.get(drag.petId);
    if (!pet) return stopDrag();
    const p = pet.engine.pet;
    const c = screen.getCursorScreenPoint();
    if (debug) dragDiag(c, p);
    const before = { x: p.x, y: p.y, display: p.display };
    // 펫은 커서가 있는 모니터로 옮겨 간다 (커서와 같은 모니터 좌표계에서 계산).
    p.display = screen.getDisplayNearestPoint(c).id;
    p.x = c.x + drag.dx;
    p.y = c.y + drag.dy;
    clampPet(pet);
    if (p.x === before.x && p.y === before.y && p.display === before.display) return;
    sendAll('pet:state', { id: pet.id, ...p });
    if (focusPetId === pet.id && pet.host.isOpen && focusDisplay !== p.display) syncChatFocus();
  }

  function stopDrag() {
    if (drag) clearInterval(drag.timer);
    drag = null;
    if (focusSyncPending) syncChatFocus(); // 끄는 동안 미뤄 둔 포커스 이동
  }

  ipcMain.on('pet:dragging', (e, petId, dragging) => {
    const pet = petOf(e, petId);
    if (!pet || typeof dragging !== 'boolean') return;
    if (debug) console.log('[drag] pet:dragging', dragging, JSON.stringify(screen.getCursorScreenPoint()));
    if (dragging) {
      stopDrag();
      pet.engine.startDrag();
      const c = screen.getCursorScreenPoint();
      const p = pet.engine.pet;
      // 포인터 이벤트는 모니터 경계를 넘는 순간 끊길 수 있어, 이벤트 대신 타이머로 커서를 읽는다.
      drag = { petId: pet.id, dx: p.x - c.x, dy: p.y - c.y, timer: setInterval(followCursor, 8) };
    } else if (drag?.petId === pet.id) {
      stopDrag();
      pet.engine.endDrag();
    }
  });

  ipcMain.on('pet:menu', (e, petId) => {
    const id = findDisplayId(e.sender);
    if (id === null) return;
    const pet = typeof petId === 'string' ? pets.get(petId) : null;
    void refreshAll(); // 다음에 메뉴를 열 때를 위해 최신 상태로 갱신
    Menu.buildFromTemplate(getMenuTemplate(pet?.id)).popup({ window: windows.get(id) });
  });

  /**
   * 오버레이 창을 모두 버리고 새로 만든다. 오래 쓰던 창(숨겼다 다시 보인 창, 화면 잠금/절전을 겪은 창)은
   * 첫 마우스 누름을 놓쳐 클릭이 먹지 않는 일이 있어서, 처음 켰을 때와 같은 상태의 창으로 바꾼다.
   * 새 창은 ready-to-show에서 (보여야 할 때만) 보인다. 펫과 대화 기록은 main에 있어서 새 창이 다시 받아 간다.
   */
  function rebuildWindows() {
    for (const [id, win] of [...windows]) {
      windows.delete(id);
      if (!win.isDestroyed()) win.destroy();
    }
    for (const d of screen.getAllDisplays()) createWindow(d);
    syncChatFocus(); // 열려 있는 대화창이 있으면 새 창이 키보드 포커스를 받게 한다
  }

  /** 모든 오버레이 창을 보이거나 숨긴다. */
  function applyVisibility() {
    const show = visible && !suspended;
    if (!show) {
      for (const win of windows.values()) if (!win.isDestroyed()) win.hide();
      windowsWereHidden = true;
      return;
    }
    // hide()했다가 showInactive()로 다시 보인 창은 첫 마우스 누름(pointerdown)을 놓친다 (떼는 이벤트만 도착해
    // 클릭이 먹지 않는다). 그래서 한 번이라도 숨겼다면 다시 보일 때 새 창으로 바꾼다.
    if (windowsWereHidden) {
      windowsWereHidden = false;
      rebuildWindows();
      return;
    }
    for (const win of windows.values()) if (!win.isDestroyed()) win.showInactive();
  }

  // 화면 잠금을 풀었거나 절전에서 깨어났을 때도 같은 증상(좌클릭이 안 먹음)이 보고됐다. 원인을 확정하지는 못했지만
  // 새 창으로 바꾸면 처음 켰을 때처럼 동작하므로 같은 방법을 쓴다. (잠금/절전 중에는 창이 숨겨져 있지 않다)
  let rebuildTimer = /** @type {NodeJS.Timeout | null} */ (null);
  function rebuildAfterSessionReturn() {
    if (rebuildTimer) clearTimeout(rebuildTimer);
    // 해제 직후에는 모니터와 바탕화면이 아직 자리 잡는 중일 수 있어 잠시 기다렸다가 한 번만 바꾼다.
    rebuildTimer = setTimeout(() => {
      rebuildTimer = null;
      if (!visible || suspended) {
        windowsWereHidden = true; // 보이게 될 때 어차피 새 창으로 바뀐다
        return;
      }
      rebuildWindows();
    }, 1500);
  }
  powerMonitor.on('unlock-screen', rebuildAfterSessionReturn);
  powerMonitor.on('resume', rebuildAfterSessionReturn);

  function closeAllChats() {
    for (const pet of pets.values()) pet.host.setOpen(false);
  }

  /** @param {boolean} value */
  function setVisible(value) {
    visible = value;
    if (!value) closeAllChats();
    applyVisibility();
    store.update({ general: { visible: value } });
  }

  /** @param {boolean} value */
  function setSuspended(value) {
    if (suspended === value) return;
    suspended = value;
    if (value) {
      closeAllChats();
      for (const id of pets.keys()) hideNotice(id);
    }
    applyVisibility();
  }

  // --- 활성 창 인식 ---

  /** 가장 최근에 받은 활성 창 정보 (물리 픽셀) */
  /** @type {import('./windowWatcher.js').ForegroundInfo | null} */
  let foreground = null;

  /** 활성 창 정보로 "전체화면이라 숨길지", 펫마다 "올라갈 수 있는 창인지"를 판단해 반영한다. */
  function applyForeground() {
    const info = foreground;
    const s = store.get();
    quiet.fullscreen = !!info && (info.fs === 1 || info.busy === 1);
    setSuspended(s.behavior.hideOnFullscreen && !!info && info.fs === 1);

    const canPerch = s.behavior.sitOnWindows && !suspended && !!info && !info.none && !!info.hwnd;
    /** @type {{ x: number, y: number, width: number, height: number } | null} */
    let rect = null;
    if (canPerch && info) {
      // 도우미는 물리 픽셀을 주므로 Electron의 DIP 좌표로 바꾼다 (모니터마다 배율이 다를 수 있다).
      rect = screen.screenToDipRect(null, { x: info.x ?? 0, y: info.y ?? 0, width: info.w ?? 0, height: info.h ?? 0 });
    }
    for (const pet of pets.values()) {
      // 펫마다 몸 크기(스킨)가 달라서 올라갈 수 있는 창도 다르다.
      const perch =
        rect && info
          ? computePerch(
              { id: info.hwnd ?? '', rect, minimized: !!info.min, maximized: !!info.max, fullscreen: info.fs === 1 },
              screen.getAllDisplays(),
              pet.metrics,
            )
          : null;
      if (debug && rect && info) {
        console.log('[window]', pet.id, info.proc, JSON.stringify(rect), '→', perch ? `올라갈 수 있음 top=${perch.top} display=${perch.display}` : '올라갈 수 없음');
      }
      pet.engine.setTarget(perch);
    }
  }

  const watcher = createWindowWatcher({
    onChange: (info) => {
      if (debug) console.log('[watch] 활성 창', info.proc ?? '(없음)', info.cls ?? '', info.fs ? 'fullscreen' : '', info.busy ? 'busy' : '');
      foreground = info;
      applyForeground();
    },
    onLog: (msg) => debug && console.log('[watch]', msg),
  });

  // --- 점검 ---

  async function refreshAll() {
    await Promise.all([...pets.values()].map((p) => refreshPet(p)));
  }

  /** 연결 id → 점검 결과 (설정 창에 보여 준다). 펫이 없는(꺼진) 연결은 포함되지 않는다. */
  function statuses() {
    /** @type {Record<string, { checked: boolean, available: boolean, reason: string, info: string }>} */
    const out = {};
    for (const [id, pet] of pets) {
      const b = pet.host.backends()[0];
      out[id] = { checked: !!b?.checked, available: !!b?.available, reason: b?.reason ?? '', info: b?.info ?? '' };
    }
    return out;
  }

  // --- 시작/정리 ---

  /**
   * 마우스 이동 알림의 보조 경로. 클릭 통과 중인 창은 Electron이 Windows 전역 마우스 훅(WH_MOUSE_LL)으로 받아 전달하는
   * 이동 이벤트로만 "펫 위에 마우스가 올라왔는지" 알 수 있다. 그런데 Windows는 PC가 바쁘거나 다른 프로그램의 훅과 겹쳐서
   * 훅이 제때 응답하지 못하면 훅을 조용히 떼어 버리고, Electron은 그걸 모른 채 다시 설치하지 않는다. 그러면 펫이 마우스를
   * 영영 받지 못해 클릭이 아래 창으로 새어 나간다. 그래서 앱이 직접 커서 위치를 읽어 각 창에 알려 준다 (드래그 때와 같은 방식).
   * 렌더러는 정상적인 이벤트가 오는 동안에는 이 값을 쓰지 않는다.
   */
  /** @type {Map<number, string>} 창(모니터 id) → 마지막으로 보낸 값 (같으면 다시 보내지 않는다) */
  const cursorSent = new Map();
  function sendCursor() {
    if (!visible || suspended || windows.size === 0) return;
    const c = screen.getCursorScreenPoint();
    for (const [id, win] of windows) {
      if (win.isDestroyed() || !win.isVisible()) continue;
      const b = win.getBounds();
      const inside = c.x >= b.x && c.x < b.x + b.width && c.y >= b.y && c.y < b.y + b.height;
      const key = inside ? `${c.x},${c.y}` : '';
      if (cursorSent.get(id) === key) continue;
      cursorSent.set(id, key);
      win.webContents.send('overlay:cursor', inside ? { x: c.x, y: c.y } : null);
    }
  }
  const cursorTimer = noCursorPoll ? null : setInterval(sendCursor, 40);

  const tickMs = (debug && Number(process.env.AIPET_NOTIFY_TICK_MS)) || 30_000;
  const tickTimer = setInterval(() => notifier.tick(), tickMs);

  app.on('before-quit', () => {
    if (rebuildTimer) clearTimeout(rebuildTimer);
    powerMonitor.off('unlock-screen', rebuildAfterSessionReturn);
    powerMonitor.off('resume', rebuildAfterSessionReturn);
    for (const pet of pets.values()) pet.host.dispose();
    watcher.stop();
    clearInterval(tickTimer);
    if (cursorTimer) clearInterval(cursorTimer);
  });

  // 설정(연결, 스킨 크기, 올라가기 등)이 바뀌면 펫과 활성 창 판단을 다시 맞춘다.
  store.onChange(() => {
    void syncPets();
    applyForeground();
  });

  return {
    /** 화면에 있는 펫들 (표시 순서) */
    listPets: () => [...pets.values()].map((p) => ({ id: p.id, name: p.conn.name, kind: p.conn.kind, persona: p.conn.persona })),
    statuses,
    refreshAll,
    /** @param {string} id */
    refresh: (id) => {
      const pet = pets.get(id);
      return pet ? refreshPet(pet) : Promise.resolve();
    },
    /** 점검 결과나 펫 목록이 바뀔 때 알림을 받는다 @param {() => void} cb */
    onStatus(cb) {
      statusListeners.add(cb);
      return () => statusListeners.delete(cb);
    },
    isVisible: () => visible,
    setVisible,

    /** 창과 펫을 만들고 활성 창 감시를 시작한다. */
    async start() {
      screen.on('display-added', syncDisplays);
      screen.on('display-removed', syncDisplays);
      screen.on('display-metrics-changed', syncDisplays);
      syncDisplays();
      await syncPets();

      // 디버그용: AIPET_FAKE_WINDOW="x,y,w,h"(물리 픽셀)를 주면 실제 창 대신 그런 활성 창이 있는 것처럼 동작한다.
      // 사용자의 실제 창이나 포커스를 건드리지 않고 올라가기 흐름을 검증할 수 있다.
      const fake = debug ? process.env.AIPET_FAKE_WINDOW?.split(',').map(Number) : null;
      if (fake && fake.length === 4 && fake.every(Number.isFinite)) {
        foreground = { hwnd: 'fake', pid: 0, proc: 'fake', cls: 'fake', x: fake[0], y: fake[1], w: fake[2], h: fake[3], min: 0, max: 0, fs: 0, busy: 0 };
        applyForeground();
      } else {
        watcher.start();
      }

      // 디버그용: AIPET_TEST_NOTICE="문구"를 주면 3초 뒤 첫 펫이 알림 말풍선을 띄운다.
      if (debug && process.env.AIPET_TEST_NOTICE) {
        setTimeout(() => {
          const id = primaryPetId();
          if (id) showNotice(id, { text: /** @type {string} */ (process.env.AIPET_TEST_NOTICE), kind: 'reminder' });
        }, 3000);
      }
      // 디버그용: AIPET_AUTOTEST_MSG를 주면 시작 후 첫 펫의 대화창을 열고 그 메시지를 보낸다.
      if (debug && process.env.AIPET_AUTOTEST_MSG) {
        setTimeout(() => {
          const pet = pets.get(primaryPetId() ?? '');
          if (!pet) return;
          pet.host.setOpen(true);
          void pet.host.send(/** @type {string} */ (process.env.AIPET_AUTOTEST_MSG));
        }, 2500);
      }
    },
  };
}
