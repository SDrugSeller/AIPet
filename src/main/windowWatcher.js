// @ts-check
// 활성(포그라운드) 창의 위치/상태를 읽는 Windows 도우미.
//
// 상주하는 PowerShell 프로세스 하나가 Win32 API를 호출해 0.1초마다 상태를 확인하고, 바뀔 때만 JSON 한 줄을 출력한다.
// 프라이버시: 창의 "위치/크기/상태"와 프로세스 이름만 읽는다. 창 제목과 내용은 읽지 않는다. 값은 이 PC 밖으로 나가지 않는다.
// 좌표는 물리 픽셀이다 (DPI 인식 프로세스로 실행). 호출하는 쪽에서 screen.screenToDipRect로 DIP로 바꿔 쓴다.
import { spawn } from 'node:child_process';

/**
 * @typedef {{
 *   none?: boolean,
 *   hwnd?: string, pid?: number, proc?: string, cls?: string,
 *   x?: number, y?: number, w?: number, h?: number,
 *   min?: number, max?: number,
 *   fs: number,
 *   busy: number,
 * }} ForegroundInfo
 *   none: 활성 창이 없음(바탕화면 등). fs: 화면을 가득 채운 전체화면 창.
 *   busy: Windows가 "전체화면 앱/발표 중"이라고 알리는 상태.
 */

const CSHARP = String.raw`
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;

public static class W {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [StructLayout(LayoutKind.Sequential)] public struct MI { public int cb; public RECT mon; public RECT work; public uint flags; }

  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsZoomed(IntPtr h);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr h, uint flags);
  [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr m, ref MI mi);
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr v);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out RECT r, int size);
  [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr h, int a, out int v, int size);
  [DllImport("shell32.dll")] static extern int SHQueryUserNotificationState(out int s);

  static readonly Dictionary<uint, string> names = new Dictionary<uint, string>();
  // 작업표시줄/시작 메뉴 등 "창"으로 보지 않을 셸 창
  static readonly HashSet<string> shell = new HashSet<string> {
    "Shell_TrayWnd", "Shell_SecondaryTrayWnd", "NotifyIconOverflowWindow", "TopLevelWindowForOverflowXamlIsland",
    "Windows.UI.Core.CoreWindow", "XamlExplorerHostIslandWindow", "ForegroundStaging", "MultitaskingViewFrame", "TaskListThumbnailWnd"
  };

  static string Esc(string s) { return (s ?? "").Replace("\\", "\\\\").Replace("\"", "\\\""); }

  static string ProcName(uint pid) {
    string n;
    if (names.TryGetValue(pid, out n)) return n;
    try { n = Process.GetProcessById((int)pid).ProcessName; } catch { n = ""; }
    names[pid] = n;
    return n;
  }

  // 한 줄 JSON을 돌려준다. null이면 "바뀐 게 없는 것으로 취급"(우리 앱이 활성이거나 셸 창).
  public static string Snapshot(int self) {
    int qs, busy = 0;
    if (SHQueryUserNotificationState(out qs) == 0 && (qs == 2 || qs == 3 || qs == 4)) busy = 1;

    IntPtr h = GetForegroundWindow();
    string none = "{\"none\":true,\"fs\":0,\"busy\":" + busy + "}";
    if (h == IntPtr.Zero) return none;

    uint pid; GetWindowThreadProcessId(h, out pid);
    if ((int)pid == self) return null;

    StringBuilder sb = new StringBuilder(256); GetClassName(h, sb, 256);
    string cls = sb.ToString();
    if (cls == "Progman" || cls == "WorkerW") return none; // 바탕화면
    if (shell.Contains(cls) || !IsWindowVisible(h)) return null;
    int cloaked; DwmGetWindowAttribute(h, 14, out cloaked, 4);
    if (cloaked != 0) return null; // 다른 가상 데스크톱 등에서 숨겨진 창

    bool min = IsIconic(h), max = IsZoomed(h);
    RECT r;
    if (DwmGetWindowAttribute(h, 9, out r, Marshal.SizeOf(typeof(RECT))) != 0) GetWindowRect(h, out r); // 그림자를 뺀 실제 보이는 영역
    MI mi = new MI(); mi.cb = Marshal.SizeOf(typeof(MI));
    GetMonitorInfo(MonitorFromWindow(h, 2), ref mi);
    bool fs = !min && r.L <= mi.mon.L && r.T <= mi.mon.T && r.R >= mi.mon.R && r.B >= mi.mon.B;

    return "{\"hwnd\":\"" + h.ToInt64() + "\",\"pid\":" + pid + ",\"proc\":\"" + Esc(ProcName(pid)) + "\",\"cls\":\"" + Esc(cls) + "\"" +
      ",\"x\":" + r.L + ",\"y\":" + r.T + ",\"w\":" + (r.R - r.L) + ",\"h\":" + (r.B - r.T) +
      ",\"min\":" + (min ? 1 : 0) + ",\"max\":" + (max ? 1 : 0) + ",\"fs\":" + (fs ? 1 : 0) + ",\"busy\":" + busy + "}";
  }
}
`;

/** @param {number} selfPid */
function buildScript(selfPid) {
  return [
    "$ErrorActionPreference = 'SilentlyContinue'",
    '[Console]::OutputEncoding = [System.Text.Encoding]::UTF8',
    `Add-Type -TypeDefinition @"\n${CSHARP}\n"@`,
    '[void][W]::SetProcessDpiAwarenessContext([IntPtr]::new(-4))', // PER_MONITOR_AWARE_V2: 좌표를 물리 픽셀로 받는다
    `$self = ${Number(selfPid) | 0}`,
    "$last = ''",
    'while ($true) {',
    '  $line = [W]::Snapshot($self)',
    '  if ($line -ne $null -and $line -ne $last) { [Console]::Out.WriteLine($line); [Console]::Out.Flush(); $last = $line }',
    '  Start-Sleep -Milliseconds 100',
    '}',
  ].join('\n');
}

/**
 * @param {{ onChange: (info: ForegroundInfo) => void, onLog?: (msg: string) => void, selfPid?: number }} opts
 */
export function createWindowWatcher({ onChange, onLog = () => {}, selfPid = process.pid }) {
  const supported = process.platform === 'win32';
  /** @type {import('node:child_process').ChildProcess | null} */
  let child = null;
  let stopped = true;
  /** @type {number[]} 최근 재시작 시각 (너무 자주 죽으면 포기한다) */
  let restarts = [];

  function start() {
    if (!supported || child) return;
    stopped = false;
    const encoded = Buffer.from(buildScript(selfPid), 'utf16le').toString('base64');
    const c = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded], {
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child = c;
    let buf = '';
    c.stdout?.setEncoding('utf8').on('data', (chunk) => {
      buf += chunk;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line.startsWith('{')) continue;
        /** @type {ForegroundInfo} */
        let info;
        try {
          info = JSON.parse(line);
        } catch {
          continue; // 깨진 줄은 무시
        }
        try {
          onChange(info);
        } catch (e) {
          onLog(`처리 중 오류: ${/** @type {Error} */ (e).stack ?? e}`); // 처리 오류를 삼키지 않는다
        }
      }
    });
    c.stderr?.setEncoding('utf8').on('data', (d) => {
      const text = String(d).trim();
      if (text && !text.startsWith('#< CLIXML')) onLog(`stderr: ${text.slice(0, 300)}`); // CLIXML은 PowerShell의 진행 표시
    });
    c.on('error', (e) => onLog(`실행 실패: ${e.message}`));
    c.on('close', (code) => {
      child = null;
      if (stopped) return;
      const now = Date.now();
      restarts = restarts.filter((t) => now - t < 60_000);
      restarts.push(now);
      if (restarts.length > 3) {
        onLog(`활성 창 감지를 포기했어요 (코드 ${code}, 1분 안에 여러 번 종료됨)`);
        return;
      }
      onLog(`활성 창 감지 프로세스가 종료돼 다시 시작해요 (코드 ${code})`);
      setTimeout(start, 1000);
    });
  }

  function stop() {
    stopped = true;
    child?.kill();
    child = null;
  }

  return { supported, start, stop };
}
