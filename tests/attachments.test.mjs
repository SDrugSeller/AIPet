// @ts-check
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createAgentHost } from '../src/main/agent/agentHost.js';
import { historyText, prepareAttachments, withAttachmentText } from '../src/main/agent/attachParts.js';
import { createClaudeCodeAdapter } from '../src/main/agent/claudeCodeAdapter.js';
import { createCodexCliAdapter } from '../src/main/agent/codexCliAdapter.js';
import { decide } from '../src/main/agent/permissions.js';
import { createAttachmentStore } from '../src/main/attachments.js';
import { createStore, DEFAULTS } from '../src/main/store.js';
import { ATTACH_CAPS, ATTACH_DEFAULTS, buildPathNote, formatSize, imageMime, INLINE_TEXT_MAX_KB, kindOf, modeFor, normalizeLimits, planFor, safeFileName } from '../src/shared/attachments.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'aipet-attach-'));
const rm = (/** @type {string} */ d) => fs.rmSync(d, { recursive: true, force: true });
/** @param {string} dir @param {string} name @param {number} size */
const makeFile = (dir, name, size) => {
  const p = path.join(dir, name);
  fs.writeFileSync(p, Buffer.alloc(size, 65));
  return p;
};

test('기본 제한은 파일당 5MB, 5개이고 상한은 코드에 고정돼 있다', () => {
  assert.deepEqual({ ...ATTACH_DEFAULTS }, { maxFileMb: 5, maxFiles: 5 });
  assert.deepEqual(normalizeLimits({}), { maxFileMb: 5, maxFiles: 5 });
  assert.deepEqual(normalizeLimits({ maxFileMb: 8, maxFiles: 3 }), { maxFileMb: 8, maxFiles: 3 });
  assert.deepEqual(normalizeLimits({ maxFileMb: 9999, maxFiles: 999 }), { maxFileMb: ATTACH_CAPS.maxFileMb, maxFiles: ATTACH_CAPS.maxFiles }, '상한을 넘으면 상한으로');
  assert.deepEqual(normalizeLimits({ maxFileMb: 0, maxFiles: -2 }), { maxFileMb: 5, maxFiles: 5 });
  assert.deepEqual(normalizeLimits({ maxFileMb: 2.5, maxFiles: 'x' }), { maxFileMb: 5, maxFiles: 5 });
});

test('저장소: 첨부 제한은 기본값이 있고, 범위 밖 값은 저장하지 않는다', () => {
  assert.deepEqual(DEFAULTS.attachments, { maxFileMb: 5, maxFiles: 5 });
  const dir = tmp();
  try {
    const s = createStore({ file: path.join(dir, 's.json'), safeStorage: null });
    s.update({ attachments: { maxFileMb: 8 } });
    assert.equal(s.get().attachments.maxFileMb, 8);
    s.update({ attachments: { maxFileMb: 999, maxFiles: 0 } });
    assert.deepEqual(s.get().attachments, { maxFileMb: 8, maxFiles: 5 }, '범위 밖 값은 버린다');
  } finally {
    rm(dir);
  }
});

test('종류와 방식: 확장자로 가르고, 연결에 따라 직접 싣기/경로/거부가 갈린다', () => {
  assert.equal(kindOf('a.PNG'), 'image');
  assert.equal(kindOf('a.pdf'), 'pdf');
  assert.equal(kindOf('x.py'), 'text');
  assert.equal(kindOf('a.zip'), 'other');
  assert.equal(imageMime('a.jpg'), 'image/jpeg');
  assert.equal(modeFor('codex-cli'), 'path');
  assert.equal(modeFor('claude-code'), 'claude');
  assert.equal(modeFor('anthropic-api'), 'anthropic');
  assert.equal(modeFor('openai-compat'), 'openai');

  const KB = 1024;
  assert.deepEqual(planFor({ name: 'a.zip', size: 9e6 }, 'path'), { how: 'path' }, 'CLI는 무엇이든 경로로');
  assert.deepEqual(planFor({ name: 'a.png', size: 1 }, 'claude'), { how: 'inline' });
  assert.deepEqual(planFor({ name: 'a.txt', size: 10 * KB }, 'claude'), { how: 'inline' });
  assert.deepEqual(planFor({ name: 'a.txt', size: (INLINE_TEXT_MAX_KB + 1) * KB }, 'claude', { tools: true }), { how: 'path' }, '큰 글은 도구가 있으면 경로로');
  assert.ok('reject' in planFor({ name: 'a.txt', size: (INLINE_TEXT_MAX_KB + 1) * KB }, 'claude', { tools: false }));
  assert.ok('reject' in planFor({ name: 'a.zip', size: 10 }, 'claude', { tools: false }));
  assert.deepEqual(planFor({ name: 'a.pdf', size: 10 }, 'anthropic'), { how: 'inline' });
  assert.ok('reject' in planFor({ name: 'a.pdf', size: 10 }, 'openai'), 'OpenAI 호환은 PDF를 받지 못한다');
  assert.ok('reject' in planFor({ name: 'a.docx', size: 10 }, 'anthropic'));
  assert.ok('reject' in planFor({ name: 'a.txt', size: (INLINE_TEXT_MAX_KB + 1) * KB }, 'anthropic'), 'API는 큰 글을 받지 못한다');
});

test('이름과 크기 표시: 파일 이름을 안전하게 다듬고 크기를 읽기 쉽게 보여 준다', () => {
  assert.equal(formatSize(512), '512B');
  assert.equal(formatSize(1536), '1.5KB');
  assert.equal(formatSize(5 * 1048576), '5.0MB');
  assert.equal(safeFileName(String.raw`..\..\evil:name?.txt`), 'evil_name_.txt');
  assert.equal(safeFileName('보고서 최종.pdf'), '보고서 최종.pdf');
  assert.equal(safeFileName('...'), 'file');
  assert.equal(safeFileName('a'.repeat(300) + '.md').length <= 100, true);
  assert.match(buildPathNote([{ name: 'a.txt', path: 'C:\\x\\1-a.txt', size: 2048 }]), /a\.txt \(2\.0KB\): C:\\x\\1-a\.txt/);
  assert.equal(buildPathNote([]), '');
});

test('복사본 관리: 원본은 그대로 두고 복사하며, 크기·개수·폴더·빈 파일·종류를 검사한다', async () => {
  const src = tmp();
  const root = path.join(tmp(), 'attachments');
  try {
    const limits = { maxFileMb: 1, maxFiles: 2 };
    const st = createAttachmentStore({ root, getLimits: () => limits });
    const small = makeFile(src, 'a.txt', 100);
    const small2 = makeFile(src, 'b.png', 200);
    const big = makeFile(src, 'big.txt', 1048576 + 1);
    const empty = makeFile(src, 'empty.txt', 0);
    const zip = makeFile(src, 'c.zip', 50);
    const dir = path.join(src, 'folder');
    fs.mkdirSync(dir);
    const before = fs.readFileSync(small);

    const r = await st.add('pet-1', [small, big, empty, dir, path.join(src, 'nope.txt'), 'relative.txt'], { kind: 'codex-cli' });
    assert.deepEqual(r.added.map((f) => f.name), ['a.txt']);
    assert.deepEqual(r.rejected.map((x) => x.name), ['big.txt', 'empty.txt', 'folder', 'nope.txt', 'relative.txt']);
    assert.match(r.rejected[0].reason, /너무 커요.*최대 1MB/);
    assert.match(r.rejected[2].reason, /폴더/);
    assert.ok(r.added[0].path.startsWith(root) && fs.existsSync(r.added[0].path), '복사본은 앱 전용 폴더 안에');
    assert.deepEqual(fs.readFileSync(small), before, '원본은 그대로');
    assert.equal(r.added[0].how, 'path');

    // 개수 제한 (이미 1개 + 2개 더 시도 → 1개만)
    const r2 = await st.add('pet-1', [small2, zip], { kind: 'codex-cli' });
    assert.equal(r2.added.length, 1);
    assert.match(r2.rejected[0].reason, /2개까지/);
    assert.equal(st.list('pet-1').length, 2);

    // API 연결은 받을 수 없는 종류를 그 자리에서 거부한다
    const r3 = await createAttachmentStore({ root: path.join(root, 'x'), getLimits: () => ({}) }).add('pet-2', [zip], { kind: 'anthropic-api' });
    assert.equal(r3.added.length, 0);
    assert.match(r3.rejected[0].reason, /이미지, PDF, 글 파일/);

    // 연결 id가 이상하면 폴더를 만들지 않는다
    const bad = await st.add('..\\evil', [small], { kind: 'codex-cli' });
    assert.equal(bad.added.length, 0);
    assert.ok(!fs.existsSync(path.join(path.dirname(root), 'evil')));
  } finally {
    rm(src);
    rm(path.dirname(root));
  }
});

test('복사본 수명: 빼기, 보낼 때 꺼내기(복사본은 남음), 대화가 끝나면 지우기, 시작/종료 때 전부 지우기', async () => {
  const src = tmp();
  const root = path.join(tmp(), 'attachments');
  try {
    const st = createAttachmentStore({ root, getLimits: () => ({ maxFileMb: 5, maxFiles: 5 }) });
    const f1 = makeFile(src, 'a.txt', 10);
    const f2 = makeFile(src, 'b.txt', 10);
    const { added } = await st.add('pet-1', [f1, f2], { kind: 'codex-cli' });
    await st.remove('pet-1', added[0].id);
    assert.ok(!fs.existsSync(added[0].path), '뺀 첨부의 복사본은 바로 지운다');
    assert.equal(st.list('pet-1').length, 1);

    const taken = st.takePending('pet-1');
    assert.equal(taken.length, 1);
    assert.equal(st.list('pet-1').length, 0, '칩은 비워진다');
    assert.ok(fs.existsSync(taken[0].path), '보낸 파일의 복사본은 대화가 끝날 때까지 남는다 (AI가 다시 읽을 수 있다)');

    await st.clear('pet-1');
    assert.ok(!fs.existsSync(taken[0].path) && !fs.existsSync(path.join(root, 'pet-1')), '대화가 끝나면 지운다');

    // 앱이 대화 도중 꺼진 뒤 다음에 켤 때: 남아 있는 것을 전부 지운다
    fs.mkdirSync(path.join(root, 'pet-9'), { recursive: true });
    fs.writeFileSync(path.join(root, 'pet-9', 'leftover.txt'), 'x');
    st.clearAllSync();
    assert.ok(!fs.existsSync(root));
    st.clearAllSync(); // 이미 없어도 오류 없이
  } finally {
    rm(src);
    rm(path.dirname(root));
  }
});

test('요청 만들기: 방식에 따라 직접 싣기/경로 안내/제외를 나누고, 직접 싣는 합계를 지킨다', async () => {
  const files = [
    { name: 'p.png', path: 'p', size: 10, kind: 'image' },
    { name: 'd.pdf', path: 'd', size: 10, kind: 'pdf' },
    { name: 't.txt', path: 't', size: 10, kind: 'text' },
    { name: 'z.zip', path: 'z', size: 10, kind: 'other' },
  ];
  const readFile = async (/** @type {string} */ p) => Buffer.from(p === 't' ? 'hello ``` world' : p);
  const claude = await prepareAttachments(files, 'claude', { tools: true, readFile });
  assert.deepEqual(claude.binary.map((b) => [b.kind, b.mime]), [['image', 'image/png'], ['pdf', 'application/pdf']]);
  assert.equal(claude.binary[0].data, Buffer.from('p').toString('base64'));
  assert.equal(claude.textBlocks.length, 1);
  assert.doesNotMatch(claude.textBlocks[0], /hello ``` world/, '본문의 ``` 는 코드 블록을 깨지 않게 바꾼다');
  assert.deepEqual(claude.pathFiles.map((f) => f.name), ['z.zip'], '직접 못 싣는 것은 도구가 있으면 경로로');
  const text = withAttachmentText('질문', claude);
  assert.match(text, /^질문/);
  assert.match(text, /\[첨부 파일: t\.txt\]/);
  assert.match(text, /z\.zip/);

  const noTools = await prepareAttachments(files, 'claude', { tools: false, readFile });
  assert.equal(noTools.pathFiles.length, 0);
  assert.match(noTools.notes.join('\n'), /z\.zip/);

  const openai = await prepareAttachments(files, 'openai', { readFile });
  assert.deepEqual(openai.binary.map((b) => b.kind), ['image']);
  assert.ok(openai.notes.some((n) => n.startsWith('d.pdf')) && openai.notes.some((n) => n.startsWith('z.zip')));

  const huge = await prepareAttachments([{ name: 'a.png', path: 'a', size: 15 * 1048576, kind: 'image' }, { name: 'b.png', path: 'b', size: 10 * 1048576, kind: 'image' }], 'anthropic', { readFile: async () => Buffer.alloc(1) });
  assert.equal(huge.binary.length, 1, '직접 싣는 합계(20MB)를 넘는 것은 보내지 않는다');
  assert.match(huge.notes[0], /합계/);
  assert.equal(historyText('질문', [files[0]]), '질문\n(첨부: p.png — 그 메시지에서만 볼 수 있었어요)');
  assert.equal(historyText('질문', []), '질문');
});

test('권한: 첨부 복사본 폴더는 읽기 전용 도구에만 열어 주고, 쓰기나 다른 폴더는 그대로 막는다', () => {
  const policy = { autoAllowRead: true, workDir: 'C:\\work', readRoots: ['C:\\data\\attachments'] };
  const inAttach = 'C:\\data\\attachments\\pet-1\\1-a.txt';
  assert.equal(decide({ name: 'Read', input: { file_path: inAttach } }, policy).action, 'allow');
  assert.equal(decide({ name: 'Write', input: { file_path: inAttach, content: 'x' } }, policy).action, 'deny', '첨부 폴더에는 쓰지 못한다');
  assert.equal(decide({ name: 'Read', input: { file_path: 'C:\\secret\\x.txt' } }, policy).action, 'deny');
  assert.equal(decide({ name: 'Read', input: { file_path: 'C:\\work\\x.txt' } }, policy).action, 'allow');
  assert.equal(decide({ name: 'Read', input: { file_path: 'C:\\data\\attachments\\..\\other\\x.txt' } }, policy).action, 'deny', '.. 로 빠져나가지 못한다');
  assert.equal(decide({ name: 'Read', input: { file_path: inAttach } }, { autoAllowRead: true, workDir: 'C:\\work' }).action, 'deny', 'readRoots가 없으면 기존대로');
});

test('대화 호스트: 첨부 파일 이름을 대화창에 보여 주고, 어댑터에는 파일 정보를 따로 넘기며, 글 없이 파일만 보내도 된다', async () => {
  /** @type {any[]} */
  const seen = [];
  /** @type {any[]} */
  const broadcasts = [];
  const adapter = {
    id: 'fake',
    label: 'Fake',
    detect: async () => ({ ok: true }),
    async *send(/** @type {string} */ msg, /** @type {any} */ ctx) {
      seen.push([msg, ctx]);
      yield { type: 'text', delta: '네' };
      yield { type: 'done' };
    },
    respondPermission() {},
    abort() {},
  };
  const host = createAgentHost({ adapters: [adapter], engine: { poke() {}, setHold() {}, setAgentAnim() {} }, broadcast: (c, p) => broadcasts.push([c, p]) });
  await host.refresh();
  const files = [{ name: 'a.txt', path: 'C:\\x\\1-a.txt', size: 5, kind: 'text' }];
  await host.send('요약해 줘', { attachments: files });
  assert.deepEqual(seen[0], ['요약해 줘', { attachments: files }]);
  assert.ok(broadcasts.some(([c, p]) => c === 'chat:user' && p.text === '요약해 줘\n📎 a.txt'));
  await host.send('', { attachments: files });
  assert.equal(seen[1][0], '첨부한 파일을 봐 주세요.');
  await host.send('', {});
  assert.equal(seen.length, 2, '글도 파일도 없으면 보내지 않는다');
});

const onWindows = process.platform === 'win32';
/** @param {string} body */
function fakeCli(body) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'aipet-fakecli-'));
  fs.writeFileSync(path.join(dir, 'fake.mjs'), body);
  const cmd = path.join(dir, 'fake.cmd');
  fs.writeFileSync(cmd, `@echo off\r\n"${process.execPath}" "${path.join(dir, 'fake.mjs')}" %*\r\n`);
  return { cmd, dir };
}

test('claude: 이미지·PDF는 요청에 블록으로, 글은 본문에, 나머지는 경로 안내로 보낸다', { skip: onWindows ? false : 'Windows에서만' }, async () => {
  const { cmd } = fakeCli(`
let input = ''; process.stdin.setEncoding('utf8'); for await (const c of process.stdin) { input += c; if (input.includes('\\n')) break; }
const user = JSON.parse(input.split('\\n')[0]);
const content = user.message.content;
const summary = content.map((b) => b.type + (b.source ? ':' + b.source.media_type : '')).join(',') + ' | ' + content.at(-1).text.replace(/\\n/g, '/');
const out = (o) => console.log(JSON.stringify(o));
out({ type: 'system', subtype: 'init', session_id: 's' });
out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: summary } } });
out({ type: 'result', subtype: 'success', is_error: false, session_id: 's', result: summary });
`);
  const work = tmp();
  try {
    const a = createClaudeCodeAdapter({ getConfig: () => ({ path: cmd, configDir: '', tools: true, workDir: work }), metaDir: path.join(work, 'm') });
    const files = [
      { name: 'p.png', path: makeFile(work, 'p.png', 8), size: 8, kind: 'image' },
      { name: 'n.txt', path: makeFile(work, 'n.txt', 8), size: 8, kind: 'text' },
      { name: 'z.zip', path: makeFile(work, 'z.zip', 8), size: 8, kind: 'other' },
    ];
    let reply = '';
    for await (const ev of a.send('이거 봐 줘', { attachments: files })) if (ev.type === 'text') reply += ev.delta;
    assert.match(reply, /^image:image\/png,text \|/);
    assert.match(reply, /이거 봐 줘/);
    assert.match(reply, /\[첨부 파일: n\.txt\]/);
    assert.match(reply, /z\.zip/);
  } finally {
    rm(work);
  }
});

test('codex: 첨부한 이미지는 --image로 넘기고, 파일 경로는 안내 글로 알려 준다', { skip: onWindows ? false : 'Windows에서만' }, async () => {
  const { cmd } = fakeCli(`
let input = ''; process.stdin.setEncoding('utf8'); for await (const c of process.stdin) input += c;
const imgs = process.argv.flatMap((a, i) => (a === '--image' ? [process.argv[i + 1]] : []));
const out = (o) => console.log(JSON.stringify(o));
out({ type: 'item.completed', item: { id: 'i', type: 'agent_message', text: 'imgs=' + imgs.map((p) => p.split(/[\\\\/]/).pop()).join(',') + ' note=' + /1-a\\.txt/.test(input) + ' last=' + process.argv.at(-1) } });
out({ type: 'turn.completed' });
`);
  const work = tmp();
  try {
    const a = createCodexCliAdapter({ getConfig: () => ({ path: cmd, workDir: work }) });
    const files = [
      { name: 'p.png', path: path.join(work, '1-p.png'), size: 8, kind: 'image' },
      { name: 'a.txt', path: path.join(work, '1-a.txt'), size: 8, kind: 'text' },
    ];
    let reply = '';
    for await (const ev of a.send('봐 줘', { attachments: files })) if (ev.type === 'text') reply += ev.delta;
    assert.equal(reply, 'imgs=1-p.png note=true last=-', '이미지만 --image로, 프롬프트(-)는 맨 끝에');
  } finally {
    rm(work);
  }
});

test('openai 호환: 이미지는 data URL로, 글은 본문에 싣고, 받을 수 없는 것은 알려 준다', async () => {
  const { createOpenAICompatAdapter } = await import('../src/main/agent/openaiCompatAdapter.js');
  const dir = tmp();
  try {
    /** @type {any} */
    let body = null;
    const fetchImpl = /** @type {typeof fetch} */ (async (/** @type {any} */ url, /** @type {any} */ init) => {
      if (String(url).endsWith('/models')) return new Response(JSON.stringify({ data: [{ id: 'llava' }] }));
      body = JSON.parse(init.body);
      return new Response('data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } });
    });
    const a = createOpenAICompatAdapter({ getConfig: () => ({ baseUrl: 'http://127.0.0.1:1/v1', model: 'llava' }), fetchImpl });
    const png = makeFile(dir, 'p.png', 8);
    const txt = path.join(dir, 't.txt');
    fs.writeFileSync(txt, '안녕 첨부');
    const pdf = makeFile(dir, 'd.pdf', 8);
    const events = [];
    for await (const ev of a.send('봐 줘', { attachments: [
      { name: 'p.png', path: png, size: 8, kind: 'image' },
      { name: 't.txt', path: txt, size: 12, kind: 'text' },
      { name: 'd.pdf', path: pdf, size: 8, kind: 'pdf' },
    ] })) events.push(ev);
    const content = body.messages.at(-1).content;
    assert.equal(content[0].type, 'text');
    assert.match(content[0].text, /봐 줘[\s\S]*\[첨부 파일: t\.txt\][\s\S]*안녕 첨부/);
    assert.match(content[1].image_url.url, /^data:image\/png;base64,/);
    assert.ok(events.some((e) => e.type === 'trace' && /d\.pdf/.test(e.text)), 'PDF는 받을 수 없다고 알려 준다');
  } finally {
    rm(dir);
  }
});
