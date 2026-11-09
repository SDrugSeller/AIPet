// @ts-check
import fs from 'node:fs';
import path from 'node:path';
import { format } from 'node:util';

/**
 * 디버그 빌드의 동작 로그 파일.
 *  - 한 줄에 `시각 [태그] 내용`. 대화 내용·도구 입력 같은 본문은 남기지 않는다 (호출하는 쪽의 약속).
 *  - 같은 줄이 연달아 오면 한 번만 쓴다.
 *  - 1초에 `maxPerSec`줄을 넘으면 그 초의 나머지는 버리고 몇 줄을 버렸는지만 남긴다 (로그가 폭주하지 않도록).
 *  - 파일이 `maxBytes`를 넘으면 `<이름>.1.log`로 넘기고 새로 시작한다 (최대 2배 크기만 유지).
 *
 * @param {{ file: string, maxBytes?: number, maxPerSec?: number, mirror?: boolean, now?: () => number }} opts
 * @returns {{ log: (tag: string, ...args: unknown[]) => void, file: string }}
 */
export function createLogger({ file, maxBytes = 1_000_000, maxPerSec = 40, mirror = true, now = Date.now }) {
  const dir = path.dirname(file);
  const rotated = file.replace(/\.log$/, '') + '.1.log';
  let ready = false;
  let size = 0;
  let lastLine = '';
  let windowStart = 0;
  let inWindow = 0;
  let dropped = 0;

  function open() {
    if (ready) return true;
    try {
      fs.mkdirSync(dir, { recursive: true });
      size = fs.existsSync(file) ? fs.statSync(file).size : 0;
      ready = true;
    } catch {
      // 로그를 쓸 수 없어도 앱은 계속 동작한다
    }
    return ready;
  }

  /** @param {string} line */
  function write(line) {
    if (!open()) return;
    try {
      if (size > 0 && size + Buffer.byteLength(line) > maxBytes) {
        fs.rmSync(rotated, { force: true });
        fs.renameSync(file, rotated);
        size = 0;
      }
      fs.appendFileSync(file, line);
      size += Buffer.byteLength(line);
    } catch {
      // 위와 같다
    }
  }

  /** @param {number} t */
  const stamp = (t) => {
    const d = new Date(t);
    const p = (/** @type {number} */ n, w = 2) => String(n).padStart(w, '0');
    return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
  };

  return {
    file,
    log(tag, ...args) {
      const t = now();
      const body = format(...args);
      const key = `${tag} ${body}`;
      if (mirror) console.log(`[${tag}]`, ...args);
      if (key === lastLine) return;
      lastLine = key;

      if (t - windowStart >= 1000) {
        if (dropped) write(`${stamp(t)} [log] ${dropped}줄 생략 (1초에 ${maxPerSec}줄 초과)\n`);
        windowStart = t;
        inWindow = 0;
        dropped = 0;
      }
      if (++inWindow > maxPerSec) {
        dropped++;
        return;
      }
      write(`${stamp(t)} [${tag}] ${body}\n`);
    },
  };
}
