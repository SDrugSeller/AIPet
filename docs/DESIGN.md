# AIPet 설계 문서 (v0.1)

화면 위에 오버레이로 떠다니는 AI 에이전트 연동 데스크톱 펫. (참고: macOS "Not A Pet")

## 1. 목표 / 비목표

**목표**
- 투명 오버레이로 화면을 돌아다니는 펫 (Windows 11 우선, macOS 확장 가능)
- 펫과 대화하고, 펫이 에이전트로서 작업을 수행
- **범용성**: 특정 AI 제공사에 종속되지 않고 다수 사용자가 각자의 환경(공식 CLI 로그인 / API 키 / 로컬 모델)으로 사용

**비목표 (MVP 제외)**: 3D/Live2D, 모바일, 클라우드 동기화, 마켓플레이스

## 2. 확정 기술 스택

| 영역 | 선택 | 비고 |
|---|---|---|
| 런타임/셸 | **Electron** | 투명창, always-on-top, 클릭 통과, 트레이 모두 지원 |
| 언어 | **JavaScript (ESM)** | `// @ts-check` + JSDoc으로 타입 보조, ESLint |
| 렌더링 | **HTML Canvas 2D + 스프라이트 시트** | 필요 시 PixiJS로 교체. 초기엔 의존성 없음 |
| UI (말풍선/설정) | 바닐라 JS + CSS | 규모가 커지면 Preact 검토 |
| 에이전트 | **어댑터 패턴** (4장 참조) | CLI(Claude Code/Codex/Gemini), API(Anthropic/OpenAI), OpenAI 호환(Ollama 등) |
| 저장소 | 초기 JSON 파일 → 필요 시 SQLite(`better-sqlite3`) | 네이티브 모듈은 electron-rebuild 필요 |
| 비밀 저장 | Electron `safeStorage` (OS 키체인 연동) | API 키 평문 저장 금지 |
| 패키징 | `electron-builder` | Windows NSIS 우선 |
| 패키지 매니저 | npm | |

## 3. 프로세스 구조

```
Main process (Node)
 ├─ window manager   : 오버레이/설정 창 생성, 멀티모니터·DPI
 ├─ agent host       : 에이전트 어댑터 실행, 스트리밍 중계
 ├─ tools/permission : 도구 실행 및 사용자 승인 게이트
 ├─ store            : 설정/기억/대화 저장
 └─ tray, global shortcut
        ▲ IPC (contextBridge, 화이트리스트 채널만)
        ▼
Renderer (오버레이 창, 전체 화면 크기, 투명)
 ├─ pet engine  : 상태머신 + 애니메이션 + 이동 물리
 ├─ ui          : 말풍선, 입력창, 승인 프롬프트
 └─ hit-test    : 펫/UI 위에서만 마우스 수신 (그 외 클릭 통과)
```

보안 원칙: `contextIsolation: true`, `nodeIntegration: false`, preload에서 필요한 API만 노출. 에이전트/도구 실행은 전부 main에서만 수행.

## 4. 에이전트 계층

**설계 원칙**: 특정 AI 제공사에 종속되지 않는 범용 펫이 목적이다. 앱은 **사용자 자격증명(구독 로그인 토큰)을 직접 받거나 저장하지 않는다.** 인증은 (a) 사용자가 직접 로그인한 공식 CLI, (b) 사용자가 입력한 API 키, (c) 로컬 모델 중 하나로만 이루어진다.

### 4.1 이벤트/어댑터 인터페이스

```js
/** @typedef {{type:'text',delta:string}
 *  |{type:'tool_request',id:string,name:string,input:any}
 *  |{type:'status',state:'thinking'|'working'|'idle'}
 *  |{type:'done'}|{type:'error',message:string}} AgentEvent */

/** @typedef {Object} AgentAdapter
 *  @property {string} id
 *  @property {()=>Promise<{ok:boolean,reason?:string}>} detect  설치/로그인/키 유효성 점검
 *  @property {(msg:string, ctx:object)=>AsyncIterable<AgentEvent>} send
 *  @property {(id:string, allow:boolean)=>void} respondPermission
 *  @property {()=>void} abort
 */
```

펫 엔진은 `AgentEvent`만 소비한다. 각 어댑터는 자기 출력 형식을 `AgentEvent`로 변환한다. `status`는 펫 모션(고민/작업/기쁨)으로 매핑된다.

### 4.2 어댑터 종류

| 종류 | 대상 | 인증 | 도구 실행 주체 |
|---|---|---|---|
| **CLI 어댑터** | Claude Code, Codex CLI, Gemini CLI 등 | 사용자가 공식 CLI에 직접 로그인(구독 사용 가능). 앱은 토큰을 보지 않음 | CLI |
| **API 어댑터** | Anthropic, OpenAI | 사용자 API 키 (`safeStorage`) | 앱(도구 루프 직접 구현) |
| **OpenAI 호환 어댑터** | Ollama, LM Studio, OpenRouter, Gemini 호환 엔드포인트 등 | base URL + (선택) 키 | 앱 |

- **CLI 어댑터 구현 방식**: 공식 CLI를 서브프로세스로 실행해 JSON 스트림을 파싱한다. **ACP(Agent Client Protocol)** 등 표준 프로토콜을 CLI가 지원하면 이를 우선 사용해 어댑터 하나로 여러 CLI를 처리한다 (지원 범위는 구현 시점에 검증).
- **MVP 범위**: CLI 어댑터 1종(Claude Code) + OpenAI 호환 어댑터(Ollama로 로컬 테스트 가능). 이후 Codex/Gemini CLI, Anthropic/OpenAI API 순으로 추가.
- **첫 실행 흐름**: 어댑터별 `detect()`로 사용 가능한 백엔드를 자동 탐지 → 설정 화면에서 선택. CLI 미설치/미로그인 시 설치·로그인 안내만 표시한다.
- **공통 최소 기능**: 텍스트 대화, 스트리밍, 중단, 상태 이벤트. 파일/도구 기능은 어댑터별 선택 지원(capability 플래그로 노출).

### 4.3 정책/컴플라이언스

- 앱은 OAuth 로그인 중계, 토큰 추출/저장, 구독 한도를 앱 기능으로 재판매하는 형태를 **구현하지 않는다**.
- CLI 서브프로세스 방식도 제공사 약관에 영향을 받을 수 있다. 정책은 변동되므로 **배포 전 각 제공사(Anthropic, OpenAI, Google)의 최신 약관/문서를 확인**하고, 문제가 되는 어댑터는 비활성화할 수 있게 어댑터별 on/off 플래그를 둔다.
- 사용자에게 "어떤 백엔드가 어떤 계정/키로 동작하는지" 설정 화면에 명시한다.

### 4.4 권한 모델
- 읽기 전용 도구: 자동 허용 (설정으로 변경 가능)
- 파일 쓰기/명령 실행/네트워크: 펫이 말풍선으로 승인 요청 → 사용자 허용/거부
- CLI 어댑터는 CLI의 권한 요청을 `tool_request`로 중계하고 `respondPermission`으로 응답을 전달한다. API 어댑터는 앱이 직접 게이트한다.
- 허용 범위(작업 디렉터리)를 설정에서 지정

**구현 메모 (M4, Claude Code)**: `claude -p --input-format stream-json --output-format stream-json --permission-prompt-tool stdio`로 실행하면 CLI가 도구 사용 전에 stdout으로 `control_request`(`subtype: can_use_tool`, `tool_name`, `input`)를 보내고, 앱이 stdin으로 `control_response`(`behavior: allow|deny`)를 돌려준다. `--setting-sources project,local`로 사용자 전역 허용 규칙이 승인 절차를 우회하지 못하게 한다. 이 프로토콜은 공식 SDK가 쓰는 방식이지만 CLI 버전에 따라 바뀔 수 있으므로 CLI 업데이트 시 `tests/claudeTranslate.test.mjs`와 실제 실행으로 재검증한다.

## 5. 펫 엔진

### 5.1 입력 / 오버레이 / 이동
- 입력 이벤트: 마우스(클릭/드래그/호버), 시간(유휴), 에이전트 이벤트, 시스템(활성 창 변경)
- **이동**: 화면 하단/작업표시줄 위 걷기 → 이후 창 상단 걸터앉기(활성 창 좌표 필요) 확장
- **오버레이 처리**: 전체 화면 투명 창 + `setIgnoreMouseEvents(true, {forward:true})`, 펫/UI bounding box 진입 시 해제

### 5.2 애니메이션 상태 목록

우선순위: `P0` 최소 세트(M2~M3) / `P1` MVP 필수 / `P2` 권장 / `P3` 선택. 프레임 수는 권장값.

**에이전트 연동 상태** (에이전트 이벤트가 구동, 일반 행동보다 우선)

| 상태 | 트리거 | 프레임 | 루프 | 종료 | P |
|---|---|---|---|---|---|
| `think` | `status: thinking` | 4~6 | O | 이벤트 변경 | P0 |
| `work` | `status: working` | 6~8 | O | 이벤트 변경 | P0 |
| `talk` | `text` 스트리밍 중 | 3~4 | O | `done` | P1 |
| `done` | `done` | 6~8 | X | → idle | P0 |
| `attention` | `tool_request` (허가 필요) | 4~6 | O | 사용자 응답 | P1 |
| `error` | `error` | 4~6 | X | → idle | P1 |

**일반 상태**

| 상태 | 트리거 | 프레임 | 루프 | P |
|---|---|---|---|---|
| `idle` | 기본 | 4~6 | O | P0 |
| `walk` | 이동 AI | 6~8 | O | P0 |
| `run` | 알림 시 사용자에게 이동 | 6~8 | O | P2 |
| `drag` | 마우스로 집음 | 2~4 | O | P0 |
| `drop` | 놓음(착지) | 3~4 | X → idle | P1 |
| `react` | 클릭/쓰다듬기 | 4~6 | X → idle | P1 |
| `sit` | 휴식 | 4 | O | P2 |
| `sleep` | 장시간 유휴 | 4~6 | O | P2 |
| `wake` | sleep 해제 | 4~6 | X → idle | P2 |
| `climb` / `hang` | 화면·창 가장자리 | 6~8 | O | P2 |
| `sit_on_window` | 활성 창 상단 (M5) | 4~6 | O | P2 |
| `enter` / `exit` | 앱 시작/종료 | 6~8 | X | P2 |

**랜덤 동작** (유휴 중 가중치·쿨다운으로 추첨, 단발 재생 후 idle 복귀): `yawn, look_around, groom, stare_out, chase_bug, dance, doodle, startle` 등. 이름은 자유이며 `skin.json`의 `randomActions`에 등록한 것만 사용된다. 3~4개로 시작.

### 5.3 에이전트 이벤트 → 상태 매핑

| AgentEvent | 펫 상태 | 비고 |
|---|---|---|
| `status: thinking` | `think` | 말풍선 "..." |
| `status: working` | `work` | |
| `text` (delta) | `talk` | 첫 delta에서 진입 |
| `tool_request` | `attention` | 응답 전까지 유지. 펫이 `run`으로 사용자 쪽으로 이동 가능, 알림음 옵션 |
| `done` | `done` → `idle` | |
| `error` | `error` → `idle` | |
| `status: idle` | `idle` | |

우선순위: `attention` > `error` > `done` > `talk` > `work` > `think` > 드래그/클릭 > 일반 행동 > 랜덤 동작.
`attention` 중에도 `drag`는 허용하되, 놓으면 `attention`으로 복귀한다.

### 5.4 스킨 포맷

스킨 = 폴더 1개 (`skins/<name>/`). 구성: `skin.json` + 상태별 PNG 시트. 스키마는 [skins/skin.schema.json](../skins/skin.schema.json), 예시는 [skins/default/skin.json](../skins/default/skin.json).

**이미지 규격**
- 시트: **가로 1줄 스트립**, 투명 PNG, 총 너비 = `frameSize.w × frames`, 높이 = `frameSize.h`
- 기본 프레임 크기 128×128 (픽셀아트면 64×64 + `scale: 2`)
- 기본 방향: 좌향(`facing: "left"`). `flippable: true`면 우향은 코드에서 좌우 반전
- 모든 프레임에서 **anchor(발 위치)를 동일하게 유지** (걸을 때 떨림 방지)
- 루프 애니메이션은 마지막 프레임 → 첫 프레임이 자연스럽게 이어질 것

**필수/폴백**
- `idle`만 필수. 나머지가 없으면 `fallbacks` 맵(예: `attention → think`, `talk → think`)을 따르고, 그래도 없으면 `idle`로 대체
- `effects`(느낌표, zzz, 하트 등)는 상태 위에 겹치는 별도 오버레이 스프라이트로, 어떤 상태와도 조합 가능 (P3)

**로딩 규칙**: 스킨은 데이터만 포함하며 코드를 실행하지 않는다 (스크립트·URL 참조 금지). 시트 경로는 스킨 폴더 내부로 제한한다 (경로 이탈 `..` 거부).

## 6. 말을 거는 타이밍 (UX 핵심)

Not A Pet류의 차별점은 "언제 말하느냐"에 있다. 규칙:
- 사용자 호출 시에만 응답이 기본, 자발적 발화는 **옵트인 + 쿨다운 + 방해 금지 모드**
- 자발적 발화 트리거 후보: 장시간 작업 후 휴식 제안, 에이전트 작업 완료 알림, 일정 알림
- 전체화면 앱/발표 중에는 자동 침묵

## 7. 인식(Perception) — 후순위, 전부 옵트인

- 활성 창 제목/프로세스명 (로컬)
- 스크린샷 → 비전 입력 (외부 전송 전 명시 동의, 전송 내용 미리보기)
- 클립보드, 유휴 시간
- 프라이버시 원칙: 기본 OFF, 로그에 원본 이미지 미저장

## 8. 디렉터리 구조 (제안)

```
AIPet/
 ├─ package.json
 ├─ docs/DESIGN.md
 ├─ src/
 │   ├─ main/        (index.js, windows.js, petEngine.js, skin.js, store.js, config.js, menu.js, tray.js, settingsWindow.js)
 │   ├─ main/agent/  (adapter.js, agentHost.js, permissions.js, claudeCodeAdapter.js, openaiCompatAdapter.js, [apiAdapter.js: M6])
 │   ├─ shared/      (motion.js: main/renderer 공용 이동 공식)
 │   ├─ preload/     (preload.cjs, settingsPreload.cjs)
 │   ├─ renderer/    (index.html, main.js, chat.js, style.css)  오버레이
 │   └─ settings/    (index.html, settings.js, settings.css)  설정 창
 ├─ tests/         (node --test)
 ├─ tools/         (gen-placeholder-skin.mjs)
 ├─ skins/         (skin.schema.json, default/skin.json + 상태별 *.png)
 └─ eslint.config.js, jsconfig.json (checkJs)
```

## 9. 마일스톤

| M | 내용 | 완료 기준 |
|---|---|---|
| M1 | 투명 오버레이 + 정적 펫 + 드래그 + 클릭 통과 | 다른 앱 조작에 방해 없음 |
| M2 | 스프라이트 애니 + 상태머신 + 화면 하단 배회 | idle/walk/sleep 동작 |
| M3 | 말풍선 입력 + 어댑터 인터페이스 + Claude Code CLI·Ollama 어댑터 | 대화 가능, status→모션 매핑, detect() 동작 |
| M4 | 트레이, 설정, 권한 승인 UI, 저장소 | 재시작 후 설정 유지 |
| M5 | 활성 창 인식, 창 위 걸터앉기, 자발적 발화 | 쿨다운/방해금지 동작 |
| M6 | Codex/Gemini CLI·API 어댑터, 스킨 교체, 패키징 | 설치 파일 생성 |

## 10. 리스크 / 미결 사항

- 제공사별 CLI 구동/약관 범위 (4.3 참조) — 배포 전 재검토
- CLI별 출력 형식·권한 요청 프로토콜 차이 (ACP 지원 여부 조사 필요)
- 전체화면 게임/독점 전체화면 앱 위에서는 오버레이 표시 불가
- 멀티 모니터 + 혼합 DPI 좌표계 처리
- 캐릭터 아트 에셋 조달 방식 (직접 제작 / AI 생성 / 라이선스)
- Windows에서 활성 창 좌표 취득 방식 (네이티브 모듈 vs PowerShell/ffi)
