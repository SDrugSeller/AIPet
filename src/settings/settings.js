// @ts-check
// 설정 창. 값이 바뀔 때마다 자동 저장한다. 화면에 표시되는 문자열은 모두 textContent/value로만 넣는다.

import { applyTuning, checkSheets, detectFrameSize } from '../shared/skinTuning.js';

/** @type {any} */
const api = /** @type {any} */ (window).aipetSettings;

/** @type {any} */
let state = await api.get();

const $ = (/** @type {string} */ sel, /** @type {ParentNode} */ root = document) => /** @type {HTMLElement} */ (root.querySelector(sel));
const savedEl = $('#saved');
/** @type {NodeJS.Timeout | undefined} */
let savedTimer;

function flashSaved(/** @type {string} */ text = '저장됨') {
  savedEl.textContent = text;
  clearTimeout(savedTimer);
  savedTimer = setTimeout(() => (savedEl.textContent = ''), 1800);
}

/** "a.b-c.d" 경로의 값을 읽는다 @param {any} obj @param {string} path */
const getPath = (obj, path) => path.split('.').reduce((o, k) => o?.[k], obj);

/** "a.b.c" 경로와 값으로 중첩 패치 객체를 만든다 @param {string} path @param {any} value */
function toPatch(path, value) {
  const keys = path.split('.');
  /** @type {any} */
  const root = {};
  let cur = root;
  keys.forEach((k, i) => {
    cur[k] = i === keys.length - 1 ? value : {};
    cur = cur[k];
  });
  return root;
}

/** @param {any} patch */
async function save(patch) {
  const next = await api.set(patch);
  if (next) {
    state = next;
    render();
    flashSaved();
  }
}

// --- 화면 그리기 (입력 중인 칸은 건드리지 않는다) ---

function render() {
  const s = state.settings;

  for (const el of document.querySelectorAll('[data-path]')) {
    const input = /** @type {HTMLInputElement} */ (el);
    const value = getPath(s, input.dataset.path ?? '');
    if (input.type === 'checkbox') input.checked = !!value;
    else if (document.activeElement !== input) input.value = value ?? '';
  }

  // 스킨 목록 (사용자가 열어 둔 드롭다운을 닫지 않도록 내용이 바뀔 때만 다시 만든다)
  const skinSel = /** @type {HTMLSelectElement} */ ($('#skin'));
  const ids = state.skins.map((/** @type {any} */ k) => k.id).join('|');
  if (skinSel.dataset.ids !== ids) {
    skinSel.dataset.ids = ids;
    skinSel.replaceChildren(
      ...state.skins.map((/** @type {any} */ k) => {
        const o = document.createElement('option');
        o.value = k.id;
        o.textContent = k.name === k.id ? k.id : `${k.name} (${k.id})`;
        return o;
      }),
    );
  }
  skinSel.value = s.general.skin;

  // 말투 (입력 중인 칸은 건드리지 않는다)
  const pr = state.persona;
  const personaSel = /** @type {HTMLSelectElement} */ ($('#persona'));
  const pids = pr.items.map((/** @type {any} */ p) => p.id).join('|');
  if (personaSel.dataset.ids !== pids) {
    personaSel.dataset.ids = pids;
    personaSel.replaceChildren(
      ...pr.items.map((/** @type {any} */ p) => {
        const o = document.createElement('option');
        o.value = p.id;
        o.textContent = p.name;
        return o;
      }),
    );
  }
  personaSel.value = pr.selectedId;
  const personaText = /** @type {HTMLTextAreaElement} */ ($('#personaText'));
  personaText.dataset.id = pr.selectedId; // 자동 저장할 때 어느 파일인지 (선택이 바뀌는 순간의 어긋남 방지)
  if (document.activeElement !== personaText) personaText.value = pr.text;
  /** @type {HTMLButtonElement} */ ($('#personaDelete')).disabled = pr.items.length <= 1;
  $('#personaDir').textContent = `저장 위치: ${pr.dir}`;

  renderReminders();
  renderTuning();

  // 먼저 말 걸기를 끄면 하위 항목을 회색으로 비활성화한다
  const spOn = !!s.spontaneous.enabled;
  const spBox = $('#spontaneousOptions');
  spBox.style.opacity = spOn ? '1' : '0.5';
  for (const el of spBox.querySelectorAll('input, button')) /** @type {HTMLInputElement} */ (el).disabled = !spOn;

  /** @type {HTMLInputElement} */ ($('#openaiBaseUrl')).placeholder = state.defaults.openaiBaseUrl;
  /** @type {HTMLInputElement} */ ($('#workDir')).value = s.permissions.workDir || `${state.defaults.workDir}  (기본)`;
  $('#keyStatus').textContent = state.hasKey.openaiKey
    ? '저장된 키가 있어요'
    : state.keyFromEnv
      ? '환경변수(AIPET_OPENAI_KEY)의 키를 쓰는 중이에요'
      : '저장된 키 없음';
  $('#loginNote').textContent = state.packaged ? '' : '(설치본에서만 적용돼요)';

  for (const b of state.backends) {
    const card = $(`[data-backend="${b.id}"]`);
    const status = $('[data-role="status"]', card);
    const checking = b.enabled && !b.checked;
    status.textContent = !b.enabled ? '사용 안 함' : checking ? '확인 중…' : b.available ? '사용 가능' : '사용 불가';
    status.className = `badge ${checking ? '' : b.enabled && b.available ? 'ok' : 'bad'}`;
    $('[data-role="info"]', card).textContent = b.available ? b.info : '';
    $('[data-role="reason"]', card).textContent = b.enabled && b.checked && !b.available ? b.reason : '';
    /** @type {HTMLInputElement} */ ($(`input[name="backend"][value="${b.id}"]`)).checked = b.selected;
  }
}

// --- 스킨 크기 ---

const tuneFields = () => ({
  fw: /** @type {HTMLInputElement} */ ($('#tuneFW')),
  fh: /** @type {HTMLInputElement} */ ($('#tuneFH')),
  dh: /** @type {HTMLInputElement} */ ($('#tuneDH')),
});

/** 입력칸의 값을 숫자로 읽는다 (비었거나 숫자가 아니면 undefined) @param {HTMLInputElement} el */
const numOf = (el) => (el.value !== '' && Number.isFinite(Number(el.value)) ? Math.round(Number(el.value)) : undefined);

/** 입력한 값으로 환산 결과와 시트 문제를 보여 준다 */
function previewTuning() {
  const info = state.skinTuning;
  if (!info) return;
  const { fw, fh, dh } = tuneFields();
  const t = { frameW: numOf(fw), frameH: numOf(fh), displayH: numOf(dh) };
  const r = applyTuning(info.authored, t);
  $('#tuneResult').textContent =
    `결과: 화면에 ${r.displaySize.w}×${r.displaySize.h}px로 보여요 (배율 ${r.scale}) · 발 위치 (${r.anchor.x}, ${r.anchor.y}) · ` +
    `클릭 영역 x${r.hitbox.x} y${r.hitbox.y} ${r.hitbox.w}×${r.hitbox.h}`;
  const problems = checkSheets(r.frameSize, info.sheets);
  $('#tuneProblems').textContent = problems.length
    ? `시트 크기가 입력한 프레임 크기와 맞지 않아요:\n${problems.slice(0, 6).join('\n')}${problems.length > 6 ? `\n… 외 ${problems.length - 6}건` : ''}`
    : '';
}

function renderTuning() {
  const info = state.skinTuning;
  $('#tuneSection').hidden = !info;
  if (!info) return;
  const a = info.authored;
  const cur = info.current ?? {};
  $('#tuneInfo').textContent =
    `현재 스킨: ${info.id} · 원본 설정: 프레임 ${a.frameSize.w}×${a.frameSize.h}px, 화면 높이 ${Math.round(a.frameSize.h * a.scale)}px${info.current ? ' (조정됨)' : ''}`;
  const { fw, fh, dh } = tuneFields();
  const editing = [fw, fh, dh].includes(/** @type {any} */ (document.activeElement));
  if (!editing) {
    fw.value = String(cur.frameW ?? a.frameSize.w);
    fh.value = String(cur.frameH ?? a.frameSize.h);
    dh.value = String(cur.displayH ?? Math.round(a.frameSize.h * a.scale));
  }
  previewTuning();
}

for (const el of Object.values(tuneFields())) el.addEventListener('input', previewTuning);

$('#tuneDetect').addEventListener('click', () => {
  const info = state.skinTuning;
  if (!info) return;
  // idle 시트를 우선하고, 없으면 있는 시트 중 첫 번째로 감지한다.
  const sheet = info.sheets.find((/** @type {any} */ s) => s.anim === 'idle') ?? info.sheets[0];
  const found = sheet && detectFrameSize(sheet);
  if (!found) {
    flashSaved('시트에서 프레임 크기를 알아내지 못했어요 (너비가 프레임 수로 나누어떨어지지 않아요)');
    return;
  }
  const { fw, fh, dh } = tuneFields();
  const a = info.authored;
  // 표시 높이는 건드리지 않는다. 해상도만 다르면 화면 크기는 그대로 유지된다.
  fw.value = String(found.w);
  fh.value = String(found.h);
  if (numOf(dh) === undefined) dh.value = String(Math.round(a.frameSize.h * a.scale));
  previewTuning();
  flashSaved(`${sheet.anim}.png에서 프레임 ${found.w}×${found.h}px를 감지했어요. 적용을 눌러 반영하세요`);
});

$('#tuneApply').addEventListener('click', async () => {
  const info = state.skinTuning;
  if (!info) return;
  const { fw, fh, dh } = tuneFields();
  const t = { frameW: numOf(fw), frameH: numOf(fh), displayH: numOf(dh) };
  if (t.frameW === undefined || t.frameH === undefined || t.displayH === undefined) {
    flashSaved('세 칸을 모두 숫자로 입력해 주세요');
    return;
  }
  if (checkSheets({ w: t.frameW, h: t.frameH }, info.sheets).length && !window.confirm('시트 크기와 맞지 않아 그림이 깨져 보일 수 있어요. 그래도 적용할까요?')) return;
  const next = { ...state.settings.skinTuning, [info.id]: t };
  savedEl.textContent = '적용하는 중… 앱이 다시 시작돼요';
  await save({ skinTuning: next });
});

$('#tuneReset').addEventListener('click', async () => {
  const info = state.skinTuning;
  if (!info || !info.current) return;
  const next = { ...state.settings.skinTuning };
  delete next[info.id];
  savedEl.textContent = '원래대로 되돌리는 중… 앱이 다시 시작돼요';
  await save({ skinTuning: next });
});

// --- 정해진 시각 알림 ---

/** 화면의 알림 줄들에서 현재 값을 모은다 */
function collectReminders() {
  return [...document.querySelectorAll('#reminders .reminder')]
    .map((row) => ({
      time: /** @type {HTMLInputElement} */ (row.querySelector('input[type="time"]')).value,
      text: /** @type {HTMLInputElement} */ (row.querySelector('input[type="text"]')).value.trim(),
      enabled: /** @type {HTMLInputElement} */ (row.querySelector('input[type="checkbox"]')).checked,
    }))
    .filter((r) => /^\d\d:\d\d$/.test(r.time)); // 시각이 비어 있는 줄은 저장하지 않는다
}

/** @type {NodeJS.Timeout | undefined} */
let reminderTimer;
function saveReminders() {
  clearTimeout(reminderTimer);
  save(toPatch('spontaneous.reminders', collectReminders()));
}

function renderReminders() {
  const box = $('#reminders');
  const list = state.settings.spontaneous.reminders;
  const sig = JSON.stringify(list);
  if (box.dataset.sig === sig || box.contains(document.activeElement)) return; // 바뀐 게 없거나 입력 중
  box.dataset.sig = sig;
  box.replaceChildren(
    ...list.map((/** @type {any} */ r) => {
      const row = document.createElement('div');
      row.className = 'reminder';

      const time = document.createElement('input');
      time.type = 'time';
      time.value = r.time;

      const text = document.createElement('input');
      text.type = 'text';
      text.value = r.text;
      text.maxLength = 200;
      text.placeholder = '알릴 말';

      const on = document.createElement('input');
      on.type = 'checkbox';
      on.checked = r.enabled;
      on.title = '사용';

      const del = document.createElement('button');
      del.type = 'button';
      del.textContent = '삭제';
      del.addEventListener('click', () => {
        row.remove();
        saveReminders();
      });

      time.addEventListener('change', saveReminders);
      on.addEventListener('change', saveReminders);
      text.addEventListener('input', () => {
        clearTimeout(reminderTimer);
        reminderTimer = setTimeout(saveReminders, 700);
      });
      text.addEventListener('change', saveReminders);

      row.append(time, text, on, del);
      for (const el of row.querySelectorAll('input, button')) /** @type {HTMLInputElement} */ (el).disabled = !state.settings.spontaneous.enabled;
      return row;
    }),
  );
}

$('#addReminder').addEventListener('click', () => {
  const next = [...collectReminders(), { time: '12:00', text: '점심 먹을 시간이에요!', enabled: true }];
  if (next.length <= 20) save(toPatch('spontaneous.reminders', next));
});

// --- 입력 연결 ---

for (const el of document.querySelectorAll('[data-path]')) {
  const input = /** @type {HTMLInputElement} */ (el);
  const path = input.dataset.path ?? '';
  if (input.type === 'checkbox') {
    input.addEventListener('change', () => save(toPatch(path, input.checked)));
  } else {
    // 글자를 칠 때마다 저장하지 않고, 입력이 멈추거나 칸을 벗어날 때 저장한다.
    /** @type {NodeJS.Timeout | undefined} */
    let timer;
    const commit = () => {
      clearTimeout(timer);
      if (input.type === 'number') {
        if (input.value !== '' && Number.isFinite(Number(input.value))) save(toPatch(path, Number(input.value)));
        return;
      }
      save(toPatch(path, input.value.trim()));
    };
    input.addEventListener('input', () => {
      clearTimeout(timer);
      timer = setTimeout(commit, 700);
    });
    input.addEventListener('change', commit);
  }
}

for (const el of document.querySelectorAll('input[name="backend"]')) {
  el.addEventListener('change', async () => {
    const next = await api.select(/** @type {HTMLInputElement} */ (el).value);
    if (next) {
      state = next;
      render();
      flashSaved();
    }
  });
}

$('#skin').addEventListener('change', (e) => {
  savedEl.textContent = '스킨을 바꾸는 중… 앱이 다시 시작돼요';
  save(toPatch('general.skin', /** @type {HTMLSelectElement} */ (e.target).value));
});

// --- 말투 ---

$('#persona').addEventListener('change', (e) => save(toPatch('persona.selected', /** @type {HTMLSelectElement} */ (e.target).value)));

{
  const ta = /** @type {HTMLTextAreaElement} */ ($('#personaText'));
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  const commit = async () => {
    clearTimeout(timer);
    const id = ta.dataset.id;
    if (!id) return;
    const next = await api.personaSave(id, ta.value);
    if (next) {
      state = next;
      flashSaved();
    }
  };
  ta.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(commit, 700);
  });
  ta.addEventListener('blur', commit);
}

$('#personaCreate').addEventListener('click', async () => {
  const nameEl = /** @type {HTMLInputElement} */ ($('#personaNewName'));
  const r = await api.personaCreate(nameEl.value, /** @type {HTMLTextAreaElement} */ ($('#personaText')).value);
  if (!r) return;
  state = r.state;
  if (r.result.ok) nameEl.value = '';
  render();
  flashSaved(r.result.ok ? '새 말투를 만들었어요' : r.result.reason);
});

$('#personaDelete').addEventListener('click', async () => {
  const id = /** @type {HTMLSelectElement} */ ($('#persona')).value;
  if (!id || !window.confirm(`'${id.replace(/\.txt$/, '')}' 말투를 삭제할까요?`)) return;
  const r = await api.personaDelete(id);
  if (!r) return;
  state = r.state;
  render();
  flashSaved(r.result.ok ? '삭제했어요' : r.result.reason);
});

$('#personaFolder').addEventListener('click', () => api.personaOpenFolder());

$('#saveKey').addEventListener('click', async () => {
  const input = /** @type {HTMLInputElement} */ ($('#openaiKey'));
  if (!input.value) return;
  const r = await api.setSecret('openaiKey', input.value);
  input.value = '';
  if (r) {
    state = r.state;
    render();
    flashSaved(r.result.ok ? '키를 저장했어요' : r.result.reason);
  }
});

$('#clearKey').addEventListener('click', async () => {
  const r = await api.setSecret('openaiKey', null);
  if (r) {
    state = r.state;
    render();
    flashSaved('키를 삭제했어요');
  }
});

$('#pickDir').addEventListener('click', async () => {
  const dir = await api.pickDir();
  if (dir) save(toPatch('permissions.workDir', dir));
});

$('#resetDir').addEventListener('click', () => save(toPatch('permissions.workDir', '')));

$('#recheck').addEventListener('click', async () => {
  savedEl.textContent = '확인 중…';
  const next = await api.recheck();
  if (next) {
    state = next;
    render();
    flashSaved('확인했어요');
  }
});

// 메뉴 등 다른 곳에서 설정이 바뀌었을 때
api.onState((/** @type {any} */ next) => {
  state = next;
  render();
});

// --- 탭 ---

const tabButtons = /** @type {HTMLElement[]} */ ([...document.querySelectorAll('[role="tab"]')]);

/** @param {string} id 탭 id ("ai", "persona", ...) */
function selectTab(id) {
  for (const t of tabButtons) {
    const on = t.id === `tab-${id}`;
    t.setAttribute('aria-selected', String(on));
    t.tabIndex = on ? 0 : -1;
    const panel = document.getElementById(/** @type {string} */ (t.getAttribute('aria-controls')));
    if (panel) panel.hidden = !on;
  }
  window.scrollTo({ top: 0 });
  try {
    localStorage.setItem('aipet.settings.tab', id);
  } catch {
    // 저장소를 못 써도 탭 전환에는 문제없다
  }
}

for (const t of tabButtons) {
  t.addEventListener('click', () => selectTab(t.id.replace('tab-', '')));
  // 화살표 키로 탭 이동 (접근성)
  t.addEventListener('keydown', (e) => {
    const i = tabButtons.indexOf(t);
    const next = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? tabButtons.length - 1 : -1;
    if (next < 0) return;
    e.preventDefault();
    const target = tabButtons[(next + tabButtons.length) % tabButtons.length];
    target.focus();
    selectTab(target.id.replace('tab-', ''));
  });
}

{
  let last = null;
  try {
    last = localStorage.getItem('aipet.settings.tab');
  } catch {
    // 무시
  }
  if (last && tabButtons.some((t) => t.id === `tab-${last}`)) selectTab(last);
}

render();
