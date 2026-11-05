// @ts-check
// 설정 창. 값이 바뀔 때마다 자동 저장한다. 화면에 표시되는 문자열은 모두 textContent/value로만 넣는다.

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

render();
