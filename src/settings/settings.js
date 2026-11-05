// @ts-check
// 설정 창. 값이 바뀔 때마다 자동 저장한다. 화면에 표시되는 문자열은 모두 textContent/value로만 넣는다.

import { KIND_IDS, KINDS, MAX_CONNECTIONS } from '../shared/connections.js';
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
  savedTimer = setTimeout(() => (savedEl.textContent = ''), 2400);
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

/** 새 상태를 받아 화면을 갱신한다 @param {any} next */
function apply(next) {
  if (!next) return;
  state = next;
  render();
}

/** 이름 목록에서 쓸 옵션 요소 @param {string} value @param {string} text */
function option(value, text) {
  const o = document.createElement('option');
  o.value = value;
  o.textContent = text;
  return o;
}

// ---------------------------------------------------------------- 연결(캐릭터) 카드

/** 종류별 입력칸. type: bool 체크박스 / text 글 / dir 글+폴더 선택 / key API 키 */
const FIELDS = /** @type {Record<string, { key: string, type: 'bool' | 'text' | 'dir' | 'key', label: string, hint?: string, placeholder?: string }[]>} */ ({
  'claude-code': [
    { key: 'tools', type: 'bool', label: '파일·명령 도구 사용', hint: '(위험한 동작은 매번 허용 여부를 물어요)' },
    { key: 'path', type: 'text', label: 'claude 실행 파일 경로', hint: '(비우면 자동 탐지)', placeholder: '자동 탐지' },
    { key: 'configDir', type: 'dir', label: '계정 설정 폴더', hint: '(여러 계정을 쓰려면 캐릭터마다 다른 폴더를 정해요. 비우면 기본 로그인 계정)' },
  ],
  'codex-cli': [
    { key: 'path', type: 'text', label: 'codex 실행 파일 경로', hint: '(비우면 자동 탐지)', placeholder: '자동 탐지' },
    { key: 'model', type: 'text', label: '모델', hint: '(비우면 Codex 기본값)', placeholder: '예: gpt-5-codex' },
  ],
  'gemini-cli': [
    { key: 'path', type: 'text', label: 'gemini 실행 파일 경로', hint: '(비우면 자동 탐지)', placeholder: '자동 탐지' },
    { key: 'model', type: 'text', label: '모델', hint: '(비우면 Gemini 기본값)', placeholder: '예: gemini-2.5-pro' },
  ],
  'anthropic-api': [
    { key: 'model', type: 'text', label: '모델', hint: '(더 저렴한 모델: claude-sonnet-5-5, claude-haiku-5-5)', placeholder: 'claude-opus-5-5' },
    { key: 'key', type: 'key', label: 'API 키', hint: '(OS 보안 저장소에 암호화해 저장돼요)' },
    { key: 'baseUrl', type: 'text', label: 'API 주소', hint: '(프록시를 쓸 때만. 비우면 기본값)', placeholder: 'https://api.anthropic.com' },
  ],
  'openai-compat': [
    { key: 'baseUrl', type: 'text', label: '서버 주소', placeholder: 'http://127.0.0.1:11434/v1' },
    { key: 'model', type: 'text', label: '모델', hint: '(비우면 서버의 첫 모델)', placeholder: '예: llama3.2' },
    { key: 'key', type: 'key', label: 'API 키', hint: '(선택, OS 보안 저장소에 암호화해 저장돼요)' },
  ],
});

/** 종류별 안내 한 줄 */
const KIND_NOTE = /** @type {Record<string, string>} */ ({
  'claude-code': '파일 읽기/쓰기와 명령 실행까지 할 수 있어요 (쓰기·실행은 말풍선에서 허용해야 해요).',
  'codex-cli': '읽기 전용으로 실행돼요 (파일을 바꾸지 않아요). 터미널에서 codex login으로 로그인해 두세요.',
  'gemini-cli': '읽기 전용(plan 모드)으로 실행돼요. 터미널에서 gemini로 로그인하거나 GEMINI_API_KEY를 설정해 두세요.',
  'anthropic-api': '대화만 해요 (도구 없음). 키를 확인하는 요청은 토큰을 쓰지 않아요.',
  'openai-compat': '대화만 해요 (도구 없음). Ollama, LM Studio, OpenRouter 등 OpenAI 호환 서버를 쓸 수 있어요.',
});

/**
 * 카드 하나가 가진 요소들. 구조(연결 목록/종류/스킨·말투 목록)가 같으면 카드를 다시 만들지 않고 값만 갱신해서,
 * 입력 중인 칸이 사라지지 않게 한다.
 * @typedef {{ root: HTMLElement, update: (conn: any) => void }} Card
 * @type {Map<string, Card>}
 */
const cards = new Map();
let cardsSig = '';

/** 연결 하나의 값을 바꿔 저장한다 @param {string} id @param {(c: any) => void} mutate */
function patchConnection(id, mutate) {
  const next = state.settings.connections.map((/** @type {any} */ c) => {
    if (c.id !== id) return c;
    const copy = structuredClone(c);
    mutate(copy);
    return copy;
  });
  return save({ connections: next });
}

/** 입력이 멈추면 저장하는 입력칸 @param {HTMLInputElement} input @param {(value: string) => void} onCommit */
function debounced(input, onCommit) {
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  const commit = () => {
    clearTimeout(timer);
    onCommit(input.value.trim());
  };
  input.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(commit, 700);
  });
  input.addEventListener('change', commit);
}

/** @param {string} tag @param {string} [cls] @param {string} [text] */
function el(tag, cls = '', text = '') {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text) e.textContent = text;
  return e;
}

/** @param {any} conn 처음 보는 연결 @returns {Card} */
function buildCard(conn) {
  const id = conn.id;
  const kind = KINDS[/** @type {keyof typeof KINDS} */ (conn.kind)];
  const root = el('article', 'card');
  root.dataset.conn = id;

  // 머리: 이름, 종류, 상태, 켜기/삭제
  const head = el('header');
  const nameInput = /** @type {HTMLInputElement} */ (el('input', 'conn-name'));
  nameInput.type = 'text';
  nameInput.maxLength = 40;
  nameInput.setAttribute('aria-label', '캐릭터 이름');
  debounced(nameInput, (v) => v && patchConnection(id, (c) => (c.name = v)));
  const kindLabel = el('span', 'kind', kind.label);
  const badge = el('span', 'badge');
  head.append(nameInput, kindLabel, badge);
  root.append(head);

  const info = el('pre', 'info');
  const reason = el('p', 'reason');
  root.append(info, reason);

  // 켜기 + 삭제
  const row = el('div', 'inline spread');
  const enabledLabel = el('label', 'row');
  const enabled = /** @type {HTMLInputElement} */ (el('input'));
  enabled.type = 'checkbox';
  enabled.addEventListener('change', () => patchConnection(id, (c) => (c.enabled = enabled.checked)));
  enabledLabel.append(enabled, document.createTextNode(' 캐릭터로 화면에 띄우기'));
  const removeBtn = el('button', '', '삭제');
  removeBtn.type = 'button';
  removeBtn.addEventListener('click', async () => {
    if (!window.confirm(`'${conn.name}' 연결을 삭제할까요? 저장된 API 키도 함께 지워져요.`)) return;
    apply(await api.removeConnection(id));
    flashSaved('삭제했어요');
  });
  row.append(enabledLabel, removeBtn);
  root.append(row);

  // 스킨 + 말투
  const pair = el('div', 'grid2');
  const skinLabel = el('label', 'field', '스킨');
  const skinSel = /** @type {HTMLSelectElement} */ (el('select'));
  skinSel.addEventListener('change', () => patchConnection(id, (c) => (c.skin = skinSel.value)));
  skinLabel.append(skinSel);
  const personaLabel = el('label', 'field', '말투');
  const personaSel = /** @type {HTMLSelectElement} */ (el('select'));
  personaSel.addEventListener('change', () => patchConnection(id, (c) => (c.persona = personaSel.value)));
  personaLabel.append(personaSel);
  pair.append(skinLabel, personaLabel);
  root.append(pair);

  // 종류별 입력칸
  /** @type {Record<string, HTMLInputElement>} */
  const inputs = {};
  let keyStatus = /** @type {HTMLElement | null} */ (null);
  for (const f of FIELDS[conn.kind] ?? []) {
    if (f.type === 'bool') {
      const lab = el('label', 'row');
      const cb = /** @type {HTMLInputElement} */ (el('input'));
      cb.type = 'checkbox';
      cb.addEventListener('change', () => patchConnection(id, (c) => (c.options[f.key] = cb.checked)));
      lab.append(cb, document.createTextNode(` ${f.label} `));
      if (f.hint) lab.append(el('span', 'muted', f.hint));
      root.append(lab);
      inputs[f.key] = cb;
    } else if (f.type === 'key') {
      const box = el('div', 'field', `${f.label} `);
      if (f.hint) box.append(el('span', 'muted', f.hint));
      const inline = el('div', 'inline');
      const key = /** @type {HTMLInputElement} */ (el('input'));
      key.type = 'password';
      key.placeholder = '입력 후 저장';
      key.autocomplete = 'off';
      key.spellcheck = false;
      const save1 = el('button', '', '저장');
      save1.type = 'button';
      save1.addEventListener('click', async () => {
        if (!key.value) return;
        const r = await api.setSecret(id, key.value);
        key.value = '';
        if (r) {
          apply(r.state);
          flashSaved(r.result.ok ? '키를 저장했어요' : r.result.reason);
        }
      });
      const del1 = el('button', '', '삭제');
      del1.type = 'button';
      del1.addEventListener('click', async () => {
        const r = await api.setSecret(id, null);
        if (r) {
          apply(r.state);
          flashSaved('키를 삭제했어요');
        }
      });
      inline.append(key, save1, del1);
      keyStatus = el('span', 'muted');
      box.append(inline, keyStatus);
      root.append(box);
    } else {
      const lab = el('label', 'field', `${f.label} `);
      if (f.hint) lab.append(el('span', 'muted', f.hint));
      const input = /** @type {HTMLInputElement} */ (el('input'));
      input.type = 'text';
      input.spellcheck = false;
      if (f.placeholder) input.placeholder = f.placeholder;
      debounced(input, (v) => patchConnection(id, (c) => (c.options[f.key] = v)));
      inputs[f.key] = input;
      if (f.type === 'dir') {
        const inline = el('div', 'inline');
        inline.append(input);
        const pick = el('button', '', '선택…');
        pick.type = 'button';
        pick.addEventListener('click', async () => {
          const dir = await api.pickDir();
          if (dir) patchConnection(id, (c) => (c.options[f.key] = dir));
        });
        const auto = el('button', '', '자동 지정');
        auto.type = 'button';
        auto.title = '이 캐릭터 전용 폴더를 앱 데이터 아래에 정해요';
        auto.addEventListener('click', () => {
          const sep = state.defaults.accountDir.includes('\\') ? '\\' : '/';
          patchConnection(id, (c) => (c.options[f.key] = `${state.defaults.accountDir}${sep}${id}`));
        });
        inline.append(pick, auto);
        lab.append(inline);
      } else {
        lab.append(input);
      }
      root.append(lab);
    }
  }

  // Claude Code: 계정 로그인 도움 + 다시 확인
  const tools = el('div', 'inline');
  if (conn.kind === 'claude-code') {
    const login = el('button', '', '로그인 명령 복사');
    login.type = 'button';
    login.title = '이 캐릭터의 계정 설정 폴더로 claude를 실행하는 PowerShell 명령을 복사해요';
    login.addEventListener('click', async () => {
      const r = await api.loginCommand(id);
      if (!r?.ok) return flashSaved(r?.reason ?? '명령을 만들지 못했어요');
      try {
        await navigator.clipboard.writeText(r.command);
        flashSaved('복사했어요. PowerShell에 붙여 넣어 로그인한 뒤 "다시 확인"을 눌러 주세요');
      } catch {
        flashSaved(`복사하지 못했어요. 직접 입력해 주세요: ${r.command}`);
      }
    });
    tools.append(login);
  }
  const recheck = el('button', '', '다시 확인');
  recheck.type = 'button';
  recheck.addEventListener('click', async () => {
    flashSaved('확인 중…');
    apply(await api.recheck(id));
    flashSaved('확인했어요');
  });
  tools.append(recheck);
  root.append(tools, el('p', 'muted', KIND_NOTE[conn.kind] ?? ''));

  /** 현재 값을 화면에 반영 (입력 중인 칸은 건드리지 않는다) @param {any} c */
  function update(c) {
    const active = document.activeElement;
    if (active !== nameInput) nameInput.value = c.name;
    enabled.checked = c.enabled;
    for (const [key, input] of Object.entries(inputs)) {
      if (input.type === 'checkbox') input.checked = c.options[key] !== false;
      else if (active !== input) input.value = String(c.options[key] ?? '');
    }
    // 스킨/말투 목록
    fillSelect(skinSel, state.skins.map((/** @type {any} */ k) => [k.id, k.name === k.id ? k.id : `${k.name} (${k.id})`]), c.skin);
    fillSelect(personaSel, state.personas.items.map((/** @type {any} */ p) => [p.id, p.name]), c.persona);

    // 상태 배지
    const st = state.statuses[c.id];
    const checking = c.enabled && !!st && !st.checked;
    badge.textContent = !c.enabled ? '꺼짐' : !st ? '시작 중…' : checking ? '확인 중…' : st.available ? '사용 가능' : '사용 불가';
    badge.className = `badge ${!c.enabled || !st || checking ? '' : st.available ? 'ok' : 'bad'}`;
    info.textContent = c.enabled && st?.available ? st.info : '';
    reason.textContent = c.enabled && st?.checked && !st.available ? st.reason : '';

    if (keyStatus) {
      const envKey = c.kind === 'anthropic-api' ? state.keyFromEnv.anthropic : state.keyFromEnv.openai;
      keyStatus.textContent = state.hasKey[c.id] ? '저장된 키가 있어요' : envKey ? '환경변수의 키를 쓰는 중이에요' : '저장된 키 없음';
    }
    for (const [key, input] of Object.entries(inputs)) {
      if (key === 'baseUrl' && c.kind === 'openai-compat') input.placeholder = state.defaults.openaiBaseUrl;
    }
  }

  return { root, update };
}

/** 선택 목록을 채운다. 내용이 같으면 다시 만들지 않는다 (열어 둔 드롭다운이 닫히지 않게). @param {HTMLSelectElement} sel @param {string[][]} pairs @param {string} value */
function fillSelect(sel, pairs, value) {
  const sig = pairs.map((p) => p[0]).join('|');
  if (sel.dataset.sig !== sig) {
    sel.dataset.sig = sig;
    sel.replaceChildren(...pairs.map(([v, t]) => option(v, t)));
  }
  if (pairs.some((p) => p[0] === value)) sel.value = value;
  else sel.value = '';
}

function renderConnections() {
  const list = state.settings.connections;
  const box = $('#connections');
  const sig = JSON.stringify(list.map((/** @type {any} */ c) => [c.id, c.kind]));
  if (sig !== cardsSig) {
    cardsSig = sig;
    cards.clear();
    box.replaceChildren();
    if (!list.length) box.append(el('p', 'muted', '아직 연결이 없어요. 아래에서 추가해 보세요.'));
    for (const c of list) {
      const card = buildCard(c);
      cards.set(c.id, card);
      box.append(card.root);
    }
  }
  for (const c of list) cards.get(c.id)?.update(c);

  // 추가 안내
  const full = list.length >= MAX_CONNECTIONS;
  /** @type {HTMLButtonElement} */ ($('#addConnection')).disabled = full;
  $('#addNote').textContent = full
    ? `연결은 최대 ${MAX_CONNECTIONS}개까지 만들 수 있어요.`
    : `켜 둔 연결 하나마다 캐릭터가 한 마리씩 나타나요 (${list.filter((/** @type {any} */ c) => c.enabled).length}마리).`;
}

{
  const kindSel = /** @type {HTMLSelectElement} */ ($('#addKind'));
  kindSel.replaceChildren(...KIND_IDS.map((k) => option(k, KINDS[k].label)));
  $('#addConnection').addEventListener('click', async () => {
    const r = await api.addConnection(kindSel.value);
    if (!r) return;
    apply(r.state);
    flashSaved(r.error ?? '연결을 추가했어요. 설정을 채우고 상태를 확인해 보세요');
  });
}

$('#recheck').addEventListener('click', async () => {
  flashSaved('모든 연결을 확인하는 중…');
  apply(await api.recheck());
  flashSaved('확인했어요');
});

// ---------------------------------------------------------------- 말투 편집

/** 지금 편집 중인 말투 파일 */
let editingPersona = '';
/** 편집창에 내용을 불러온 말투 (같은 파일을 반복해서 다시 읽지 않게) */
let loadedPersona = '';

function renderPersona() {
  const items = state.personas.items;
  const sel = /** @type {HTMLSelectElement} */ ($('#persona'));
  fillSelect(sel, items.map((/** @type {any} */ p) => [p.id, p.name]), editingPersona);
  if (!items.some((/** @type {any} */ p) => p.id === editingPersona)) {
    editingPersona = items[0]?.id ?? '';
    sel.value = editingPersona;
  }
  const ta = /** @type {HTMLTextAreaElement} */ ($('#personaText'));
  ta.dataset.id = editingPersona;
  if (editingPersona && loadedPersona !== editingPersona) {
    loadedPersona = editingPersona;
    const id = editingPersona;
    api.personaRead(id).then((/** @type {string | null} */ text) => {
      if (editingPersona === id && document.activeElement !== ta) ta.value = text ?? '';
    });
  }
  /** @type {HTMLButtonElement} */ ($('#personaDelete')).disabled = items.length <= 1;
  $('#personaDir').textContent = `저장 위치: ${state.personas.dir}`;
  const users = state.settings.connections.filter((/** @type {any} */ c) => c.persona === editingPersona).map((/** @type {any} */ c) => c.name);
  $('#personaUsers').textContent = users.length ? `이 말투를 쓰는 캐릭터: ${users.join(', ')}` : '이 말투를 쓰는 캐릭터가 아직 없어요.';
}

$('#persona').addEventListener('change', (e) => {
  editingPersona = /** @type {HTMLSelectElement} */ (e.target).value;
  loadedPersona = '';
  renderPersona();
});

{
  const ta = /** @type {HTMLTextAreaElement} */ ($('#personaText'));
  /** @type {NodeJS.Timeout | undefined} */
  let timer;
  const commit = async () => {
    clearTimeout(timer);
    const id = ta.dataset.id;
    if (id && (await api.personaSave(id, ta.value))) flashSaved();
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
  if (r.result.ok) {
    nameEl.value = '';
    editingPersona = r.result.id;
    loadedPersona = '';
  }
  apply(r.state);
  flashSaved(r.result.ok ? '새 말투를 만들었어요' : r.result.reason);
});

$('#personaDelete').addEventListener('click', async () => {
  const id = editingPersona;
  if (!id || !window.confirm(`'${id.replace(/\.txt$/, '')}' 말투를 삭제할까요? 이 말투를 쓰던 캐릭터는 다른 말투로 바뀌어요.`)) return;
  const r = await api.personaDelete(id);
  if (!r) return;
  loadedPersona = '';
  apply(r.state);
  flashSaved(r.result.ok ? '삭제했어요' : r.result.reason);
});

$('#personaFolder').addEventListener('click', () => api.personaOpenFolder());

// ---------------------------------------------------------------- 스킨 크기

/** 크기를 조정 중인 스킨의 정보 { id, authored, sheets, current } @type {any} */
let tuneData = null;
/** 조정할 스킨으로 고른 것 */
let tuneSkinId = '';

const tuneFields = () => ({
  fw: /** @type {HTMLInputElement} */ ($('#tuneFW')),
  fh: /** @type {HTMLInputElement} */ ($('#tuneFH')),
  dh: /** @type {HTMLInputElement} */ ($('#tuneDH')),
});

/** 입력칸의 값을 숫자로 읽는다 (비었거나 숫자가 아니면 undefined) @param {HTMLInputElement} el */
const numOf = (el) => (el.value !== '' && Number.isFinite(Number(el.value)) ? Math.round(Number(el.value)) : undefined);

/** 입력한 값으로 환산 결과와 시트 문제를 보여 준다 */
function previewTuning() {
  const info = tuneData;
  if (!info) return;
  const { fw, fh, dh } = tuneFields();
  const r = applyTuning(info.authored, { frameW: numOf(fw), frameH: numOf(fh), displayH: numOf(dh) });
  $('#tuneResult').textContent =
    `결과: 화면에 ${r.displaySize.w}×${r.displaySize.h}px로 보여요 (배율 ${r.scale}) · 발 위치 (${r.anchor.x}, ${r.anchor.y}) · ` +
    `클릭 영역 x${r.hitbox.x} y${r.hitbox.y} ${r.hitbox.w}×${r.hitbox.h}`;
  const problems = checkSheets(r.frameSize, info.sheets);
  $('#tuneProblems').textContent = problems.length
    ? `시트 크기가 입력한 프레임 크기와 맞지 않아요:\n${problems.slice(0, 6).join('\n')}${problems.length > 6 ? `\n… 외 ${problems.length - 6}건` : ''}`
    : '';
}

/** 입력칸을 현재 저장된 값(없으면 원본 값)으로 채운다 */
function fillTuning() {
  const info = tuneData;
  if (!info) return;
  const a = info.authored;
  const cur = info.current ?? {};
  $('#tuneInfo').textContent =
    `원본 설정: 프레임 ${a.frameSize.w}×${a.frameSize.h}px, 화면 높이 ${Math.round(a.frameSize.h * a.scale)}px${info.current ? ' (조정됨)' : ''}`;
  const { fw, fh, dh } = tuneFields();
  fw.value = String(cur.frameW ?? a.frameSize.w);
  fh.value = String(cur.frameH ?? a.frameSize.h);
  dh.value = String(cur.displayH ?? Math.round(a.frameSize.h * a.scale));
  previewTuning();
}

/** 고른 스킨의 정보를 읽어 온다 @param {string} id */
async function loadTuning(id) {
  tuneSkinId = id;
  tuneData = id ? await api.skinInfo(id) : null;
  $('#tuneInfo').textContent = tuneData ? '' : '이 스킨의 정보를 읽지 못했어요.';
  fillTuning();
  /** @type {HTMLButtonElement} */ ($('#tuneApply')).disabled = !tuneData;
}

function renderTuning() {
  const skins = state.skins.map((/** @type {any} */ k) => [k.id, k.name === k.id ? k.id : `${k.name} (${k.id})`]);
  const sel = /** @type {HTMLSelectElement} */ ($('#tuneSkin'));
  fillSelect(sel, skins, tuneSkinId);
  // 처음에는 첫 캐릭터의 스킨을 보여 준다
  if (!tuneSkinId && skins.length) {
    const first = state.settings.connections[0]?.skin;
    const id = skins.some((/** @type {string[]} */ p) => p[0] === first) ? first : skins[0][0];
    sel.value = id;
    void loadTuning(id);
  }
}

$('#tuneSkin').addEventListener('change', (e) => void loadTuning(/** @type {HTMLSelectElement} */ (e.target).value));
for (const el of Object.values(tuneFields())) el.addEventListener('input', previewTuning);

$('#tuneDetect').addEventListener('click', () => {
  const info = tuneData;
  if (!info) return;
  // idle 시트를 우선하고, 없으면 있는 시트 중 첫 번째로 감지한다.
  const sheet = info.sheets.find((/** @type {any} */ s) => s.anim === 'idle') ?? info.sheets[0];
  const found = sheet && detectFrameSize(sheet);
  if (!found) {
    flashSaved('시트에서 프레임 크기를 알아내지 못했어요 (너비가 프레임 수로 나누어떨어지지 않아요)');
    return;
  }
  const { fw, fh, dh } = tuneFields();
  // 표시 높이는 건드리지 않는다. 해상도만 다르면 화면 크기는 그대로 유지된다.
  fw.value = String(found.w);
  fh.value = String(found.h);
  if (numOf(dh) === undefined) dh.value = String(Math.round(info.authored.frameSize.h * info.authored.scale));
  previewTuning();
  flashSaved(`${sheet.anim}.png에서 프레임 ${found.w}×${found.h}px를 감지했어요. 적용을 눌러 반영하세요`);
});

$('#tuneApply').addEventListener('click', async () => {
  const info = tuneData;
  if (!info) return;
  const { fw, fh, dh } = tuneFields();
  const t = { frameW: numOf(fw), frameH: numOf(fh), displayH: numOf(dh) };
  if (t.frameW === undefined || t.frameH === undefined || t.displayH === undefined) {
    flashSaved('세 칸을 모두 숫자로 입력해 주세요');
    return;
  }
  if (checkSheets({ w: t.frameW, h: t.frameH }, info.sheets).length && !window.confirm('시트 크기와 맞지 않아 그림이 깨져 보일 수 있어요. 그래도 적용할까요?')) return;
  await save({ skinTuning: { ...state.settings.skinTuning, [info.id]: t } });
  await loadTuning(info.id); // 이 스킨을 쓰는 펫은 바로 새 크기로 다시 나타난다
});

$('#tuneReset').addEventListener('click', async () => {
  const info = tuneData;
  if (!info || !info.current) return;
  const next = { ...state.settings.skinTuning };
  delete next[info.id];
  await save({ skinTuning: next });
  await loadTuning(info.id);
});

// ---------------------------------------------------------------- 정해진 시각 알림

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
      for (const e of row.querySelectorAll('input, button')) /** @type {HTMLInputElement} */ (e).disabled = !state.settings.spontaneous.enabled;
      return row;
    }),
  );
}

$('#addReminder').addEventListener('click', () => {
  const next = [...collectReminders(), { time: '12:00', text: '점심 먹을 시간이에요!', enabled: true }];
  if (next.length <= 20) save(toPatch('spontaneous.reminders', next));
});

// ---------------------------------------------------------------- 나머지 설정 입력 (data-path)

for (const e of document.querySelectorAll('[data-path]')) {
  const input = /** @type {HTMLInputElement} */ (e);
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

$('#pickDir').addEventListener('click', async () => {
  const dir = await api.pickDir();
  if (dir) save(toPatch('permissions.workDir', dir));
});

$('#resetDir').addEventListener('click', () => save(toPatch('permissions.workDir', '')));

// ---------------------------------------------------------------- 화면 그리기

function render() {
  const s = state.settings;

  for (const e of document.querySelectorAll('[data-path]')) {
    const input = /** @type {HTMLInputElement} */ (e);
    const value = getPath(s, input.dataset.path ?? '');
    if (input.type === 'checkbox') input.checked = !!value;
    else if (document.activeElement !== input) input.value = value ?? '';
  }

  renderConnections();
  renderPersona();
  renderTuning();
  renderReminders();

  // 먼저 말 걸기를 끄면 하위 항목을 회색으로 비활성화한다
  const spOn = !!s.spontaneous.enabled;
  const spBox = $('#spontaneousOptions');
  spBox.style.opacity = spOn ? '1' : '0.5';
  for (const e of spBox.querySelectorAll('input, button')) /** @type {HTMLInputElement} */ (e).disabled = !spOn;

  /** @type {HTMLInputElement} */ ($('#workDir')).value = s.permissions.workDir || `${state.defaults.workDir}  (기본)`;
  $('#loginNote').textContent = state.packaged ? '' : '(설치본에서만 적용돼요)';
}

// 다른 곳(트레이 메뉴, 점검 결과 도착 등)에서 상태가 바뀌었을 때
api.onState((/** @type {any} */ next) => apply(next));

// ---------------------------------------------------------------- 탭

const tabButtons = /** @type {HTMLElement[]} */ ([...document.querySelectorAll('[role="tab"]')]);

/** @param {string} id 탭 id ("ai", "persona", ...) */
function selectTab(id) {
  if (!tabButtons.some((t) => t.id === `tab-${id}`)) return;
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

api.onTab((/** @type {string} */ tab) => selectTab(tab));

{
  let last = state.initialTab || null;
  if (!last) {
    try {
      last = localStorage.getItem('aipet.settings.tab');
    } catch {
      // 무시
    }
  }
  if (last) selectTab(last);
}

render();
