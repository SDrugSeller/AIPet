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
| **API 어댑터** | Anthropic (구현: 대화 전용), OpenAI (미구현) | 사용자 API 키 (`safeStorage`) | 없음 (도구 루프는 미구현) |
| **OpenAI 호환 어댑터** | Ollama, LM Studio, OpenRouter, Gemini 호환 엔드포인트 등 | base URL + (선택) 키 | 앱 |

- **CLI 어댑터 구현 방식**: 공식 CLI를 서브프로세스로 실행해 JSON 스트림을 파싱한다. **ACP(Agent Client Protocol)** 등 표준 프로토콜을 CLI가 지원하면 이를 우선 사용해 어댑터 하나로 여러 CLI를 처리한다 (지원 범위는 구현 시점에 검증).
- **구현 현황**: Claude Code(도구+권한), Codex CLI(기본 읽기 전용, 설정으로 작업 폴더 샌드박스 쓰기 허용)·Gemini CLI(읽기 전용, 대화 기록은 앱이 이어 붙임), Anthropic API(공식 SDK 스트리밍; Opus/Fable/Sonnet 5.5는 서버 측 fallbacks 베타 사용, 안전 거절 처리), OpenAI 호환(Ollama 등). 외부 서버/계정과의 실제 통신은 가짜 서버·CLI 출력 기반 테스트로만 검증했다.
- **다중 연결**: 연결(`connections[]`: id, name, kind, enabled, skin, persona, options)이 곧 캐릭터다. 연결마다 `AgentHost`+어댑터가 하나씩 만들어지고, 펫 엔진·말풍선·권한 카드도 연결(petId)별로 분리된다. 같은 종류를 여러 개 둘 수 있으며(최대 8) Claude Code는 연결마다 `CLAUDE_CONFIG_DIR`를 달리해 계정을 나눈다. API 키는 `key:<id>`로 연결마다 `safeStorage`에 저장한다. 설정 변경은 `syncPets`가 실행 중인 펫을 추가/제거/갱신한다.
- **첫 실행 흐름**: 어댑터별 `detect()`로 사용 가능한 백엔드를 자동 탐지 → 설정 화면에서 선택. CLI 미설치/미로그인 시 설치·로그인 안내만 표시한다.
- **공통 최소 기능**: 텍스트 대화, 스트리밍, 중단, 상태 이벤트. 파일/도구 기능은 어댑터별 선택 지원(capability 플래그로 노출).

### 4.3 정책/컴플라이언스

- 앱은 OAuth 로그인 중계, 토큰 추출/저장, 구독 한도를 앱 기능으로 재판매하는 형태를 **구현하지 않는다**.
- CLI 서브프로세스 방식도 제공사 약관에 영향을 받을 수 있다. 정책은 변동되므로 **배포 전 각 제공사(Anthropic, OpenAI, Google)의 최신 약관/문서를 확인**하고, 문제가 되는 어댑터는 비활성화할 수 있게 어댑터별 on/off 플래그를 둔다.
- 사용자에게 "어떤 백엔드가 어떤 계정/키로 동작하는지" 설정 화면에 명시한다.

### 4.4 권한 모델
- 읽기 전용 도구: 자동 허용 (설정으로 변경 가능)
- 파일 쓰기/명령 실행/네트워크: 펫이 말풍선으로 승인 요청 → 사용자 허용/거부. 승인이 잦다는 피드백에 따라 항목별로 묻지 않고 허용하는 설정을 둔다(`permissions.autoAllowEdit` 파일 쓰기·수정, `autoAllowShell` 명령 실행, `autoAllowFetch` 웹 페이지 가져오기, 모두 기본 꺼짐). 작업 폴더 밖의 경로는 이 설정과 무관하게 항상 거부하고, 목록에 없는 도구(MCP 등)는 항상 묻는다. 자동 허용한 일은 대화창에 흔적 줄을 남긴다. 명령 실행은 명령이 건드리는 경로를 검사할 수 없어 작업 폴더 밖도 영향을 줄 수 있으므로, 켜기 전에 확인창을 띄운다.
- CLI 어댑터는 CLI의 권한 요청을 `tool_request`로 중계하고 `respondPermission`으로 응답을 전달한다. API 어댑터는 앱이 직접 게이트한다.
- 허용 범위(작업 디렉터리)를 설정에서 지정
- Codex는 승인 요청을 앱으로 넘기지 못해(비대화형 `exec`) 항목별 승인이 불가능하다. 설정(`permissions.codexWrite`, 기본 꺼짐)을 켜면 `--sandbox workspace-write`로 실행해 작업 폴더 안 파일 수정·명령 실행을 자동으로 진행하고(샌드박스가 작업 폴더 밖 쓰기(임시 폴더 제외)와 네트워크를 차단, 읽기는 막지 않음), 실행한 일은 `trace` 이벤트로 대화창에 남긴다. 샌드박스를 끄는 옵션(`danger-full-access`, `--dangerously-bypass-approvals-and-sandbox`)은 쓰지 않는다. Gemini의 `auto_edit`/`yolo`는 개인 계정 이용 종료와 `yolo`의 위험 때문에 보류.
- 웹 검색은 설정(`permissions.autoAllowWeb`, 기본 꺼짐)으로 허용: Claude Code는 `WebSearch` 승인을 자동 허용(`WebFetch`는 계속 묻는다), Codex는 `-c web_search="live"`, Gemini는 plan 모드의 검색 허용을 시스템 프롬프트로 안내(강제 아님). API/Ollama 연결은 도구가 없어 불가.

**구현 메모 (M4, Claude Code)**: `claude -p --input-format stream-json --output-format stream-json --permission-prompt-tool stdio`로 실행하면 CLI가 도구 사용 전에 stdout으로 `control_request`(`subtype: can_use_tool`, `tool_name`, `input`)를 보내고, 앱이 stdin으로 `control_response`(`behavior: allow|deny`)를 돌려준다. `--setting-sources project,local`로 사용자 전역 허용 규칙이 승인 절차를 우회하지 못하게 한다. 이 프로토콜은 공식 SDK가 쓰는 방식이지만 CLI 버전에 따라 바뀔 수 있으므로 CLI 업데이트 시 `tests/claudeTranslate.test.mjs`와 실제 실행으로 재검증한다.

## 5. 펫 엔진

### 5.1 입력 / 오버레이 / 이동
- 입력 이벤트: 마우스(클릭/드래그/호버), 시간(유휴), 에이전트 이벤트, 시스템(활성 창 변경)
- **이동**: 화면 하단/작업표시줄 위 걷기 → 이후 창 상단 걸터앉기(활성 창 좌표 필요) 확장
- **활성 창 위 걸터앉기 (M5)**: `windowWatcher`가 활성 창의 위치/크기/전체화면 여부를 알리면(물리 픽셀 → `screen.screenToDipRect`로 DIP 변환), `perch.js`가 올라갈 수 있는 창인지 판정하고 `petEngine`이 걸어가 → 점프 → 착지 → 창 윗변에서 거닐기 → 창이 움직이면 따라가기 → 활성 창이 바뀌면 낙하를 처리한다.
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
| `wake` | sleep 해제. 다른 펫이 깨웠을 때도 쓴다(1.1초, 깨운 펫 쪽을 봄). 없으면 `attention`으로 대체 | 4~6 | X → idle | P2 |
| `nudge` | 자고 있는 다른 펫을 깨우는 쪽의 손짓(펫끼리 어울리기, `src/main/social.js`). 없으면 `talk`로 대체 | 4~6 | X → idle | P2 |
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

**스킨 위치 (번들 + 사용자)**: 스킨은 두 곳에서 찾는다. ① 앱에 포함된 `skins/`(설치본에서는 읽기 전용 asar 안), ② 사용자 폴더 `userData/skins/`(Windows: `%APPDATA%/AIPet/skins`). 설치본에서도 사용자가 폴더를 넣어 스킨을 추가할 수 있다. 구현은 `src/main/skinRoots.js`(Electron 비의존, 테스트 대상).
- 같은 이름이면 **번들이 우선**(사용자가 `default` 등을 덮어쓰지 못함).
- 사용자 스킨은 신뢰할 수 없는 입력으로 취급한다: 폴더 이름은 `^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$`(`aipet-skin://` 호스트로 쓰이므로), `skin.json` 256KB 이하, `validateSkin`으로 범위 검사(frameSize 8~2048, frames 1~64 정수, fps 0.1~60, sheet는 폴더 안 `.png` 상대경로, 상태 이름 형식, 애니메이션 64개 이하). 통과하지 못하면 목록에서 빼고 불러오기도 거부한다. 번들 스킨에는 이 검사를 적용하지 않는다(기존 동작 유지).
- `aipet-skin://<이름>/<파일>.png` 요청은 해석된 스킨 폴더 안의 PNG만 돌려준다.
- 설정 → 펫 → "스킨 추가"에서 폴더 열기/목록 새로고침. 이미 로드된 스킨의 파일을 고치면 앱 재시작이 필요하다(핫 리로드 없음).
- 알려진 한계: 심볼릭 링크/정션으로 폴더 밖을 가리키는 경우는 막지 않는다(사용자가 직접 만든 링크를 전제). 스킨 설치 UI(압축 파일 가져오기, 드래그 앤 드롭)는 없다. 폴더를 직접 넣는다.

## 6. 말을 거는 타이밍 (UX 핵심)

Not A Pet류의 차별점은 "언제 말하느냐"에 있다. 규칙:
- 사용자 호출 시에만 응답이 기본, 자발적 발화는 **옵트인 + 쿨다운 + 방해 금지 모드**
- 자발적 발화 트리거 후보: 장시간 작업 후 휴식 제안, 에이전트 작업 완료 알림, 일정 알림
- 전체화면 앱/발표 중에는 자동 침묵 (M5 구현: `spontaneous.js`. 방해 금지, 쿨다운, 대화 중 침묵, 정해진 시각 알림은 조용한 동안 보류했다가 30분 안에 전달)

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
 │   ├─ main/agent/  (adapter.js, agentHost.js, permissions.js, factory.js, cli.js, claudeCodeAdapter.js, codexCliAdapter.js, geminiCliAdapter.js, anthropicApiAdapter.js, openaiCompatAdapter.js)
 │   ├─ shared/      (motion.js: main/renderer 공용 이동 공식, connections.js: 연결 종류/검증)
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
| M5.5 | 다중 연결(연결마다 펫·스킨·말투·계정), Codex/Gemini CLI·Anthropic API 어댑터 | 완료 |
| M5.6 | 첫 실행 안내 (아래 "첫 실행 안내" 참조) | 처음 쓰는 사용자가 안내만 보고 연결 완료 |
| M6 | 패키징 (개인용 스킨 제외) | 설치 파일 생성. 구현·이 PC에서 설치/실행/제거 확인 완료 (12장 참조). 코드 서명·다른 PC 검증은 남음 |

## 10. 리스크 / 미결 사항

- 제공사별 CLI 구동/약관 범위 (4.3 참조) — 배포 전 재검토
- CLI별 출력 형식·권한 요청 프로토콜 차이 (ACP 지원 여부 조사 필요)
- 전체화면 게임/독점 전체화면 앱 위에서는 오버레이 표시 불가
- 멀티 모니터 + 혼합 DPI 좌표계 처리
- 캐릭터 아트 에셋 조달 방식 (직접 제작 / AI 생성 / 라이선스)
- ~~Windows에서 활성 창 좌표 취득 방식~~ → M5에서 상주 PowerShell 도우미(Win32 API)로 해결. 설치할 것이 없고 제목/내용을 읽지 않도록 제한할 수 있다. 부하가 문제가 되면 네이티브 모듈(koffi 등)로 교체할 수 있게 `windowWatcher.js`로 분리해 두었다. macOS는 미구현.

## 11. 첫 실행 안내 (계획, M6 전에 구현)

처음 쓰는 사용자가 구독 계정/무료 키를 연결하는 흐름을 앱이 안내한다. 앱은 토큰을 받지 않는다는 원칙(4장)은 그대로다.

- 현재 상태: CLI 미설치/미로그인 시 연결 카드에 한 줄 안내가 뜬다. **쓸 수 있는 연결이 하나도 없으면 펫이 "설정 열기" 버튼이 달린 한 줄 말풍선으로 안내한다**(구현됨: `src/main/setupHint.js`, 실행마다 1회, 25초). 설치 링크, 단계별 안내, 종류 선택 마법사는 아직 없고 기본 연결은 Claude Code 하나다.
- 구독 계정별 로그인 순서 (카드에서 단계로 보여 준다):
  - Claude(Pro/Max): Claude Code 설치 → 터미널에서 `claude` 로그인 → 연결 카드의 "다시 확인". 계정이 더 필요하면 "계정 설정 폴더" + "로그인 명령 복사".
  - ChatGPT(Codex): `npm i -g @openai/codex` → `codex login`.
  - Google(Gemini): `npm i -g @google/gemini-cli` → `gemini`로 로그인 (또는 `GEMINI_API_KEY`). 로그인 여부는 앱이 정확히 알 수 없다.
  - API 키형(Anthropic API, OpenAI 호환): 키 입력.
- 만들 것: (1) 연결 추가 시 "무엇으로 연결할까요?"(구독 계정 / API 키 / 무료·로컬) 선택, (2) 종류별 설치·로그인 단계와 복사 가능한 명령, (3) CLI가 설치되면 자동 감지(주기적 재확인)해서 "다시 확인" 없이 갱신, (4) 첫 실행 시 아무것도 감지되지 않으면 안내 카드를 먼저 보여 주기.
- 확인 필요: 구독 계정을 서드파티 앱에서 CLI로 호출하는 방식이 각 제공사 약관에 맞는지는 확인하지 못했다. 배포 전 재검토(4.3).
- 무료로 쓰는 방법 (2026-11 조사, 한도와 정책은 자주 바뀌므로 구현 시 재확인):
  - ChatGPT 무료 계정: Codex CLI를 ChatGPT 로그인으로 쓰면 Free 플랜에도 포함(한도 있음, Codex Cloud 제외).
  - Gemini API 무료 키(AI Studio): 한도는 AI Studio 콘솔에서 확인. 무료 티어 요청은 Google 제품 개선에 쓰일 수 있다. OpenAI 호환 연결로 쓸 수 있다: 주소 `https://generativelanguage.googleapis.com/v1beta/openai/`, 키는 Bearer, 모델은 직접 입력(미검증).
  - Gemini CLI의 개인 Google 로그인 무료 이용은 2026-06-18에 종료되고 Antigravity CLI로 대체됐다 (2026-11-06 사용자 PC에서 `IneligibleTierError: This client is no longer supported for Gemini Code Assist for individuals`로 확인). 현재 Gemini CLI 어댑터의 안내("gemini로 로그인")를 재검토하고, 필요하면 Antigravity CLI 어댑터를 따로 조사한다.
  - 로컬: Ollama 등 (이미 지원).

## 12. 다음 작업 (진행 순서)

1. **M6 패키징** — 구현 완료, 이 PC에서 검증함 (남은 것은 아래 "남은 확인")
   - `electron-builder` 도입. `npm run pack`(폴더만) / `npm run dist`(NSIS 설치 파일, `dist/AIPet-Setup-<버전>.exe`). 0.1.1부터 `npm run dist`는 일반판과 디버그판(`dist/debug/AIPet-Setup-<버전>-debug.exe`, `tools/dist.mjs`)을 둘 다 만든다. 디버그판은 빌드 때 `package.json`에 `aipetBuild:"debug"`를 넣을 뿐 코드는 같고, 앱이 시작할 때 이 값을 읽어 `src/main/logger.js`로 `userData/logs/aipet.log`에 동작 로그를 남긴다(히트박스 표시 같은 개발용 `AIPET_DEBUG`와는 별개). 설정은 `package.json`의 `build`: `files`를 허용 목록으로 지정(`src/`, `personas/`, `skins/default`, `skins/skin.schema.json`). **`skins/genba-cat/`, `tools/`, `tests/`, `docs/`는 포함되지 않는다**(asar 목록으로 확인. 단 이 작업 폴더에는 genba-cat이 원래 없어서, 있을 때의 제외는 허용 목록 구조로만 보장됨).
   - 확인한 것 (빈 프로필, 무인 설치): (a) 스킨 경로와 `aipet-skin://` 프로토콜 정상, (b) 말투 기본 파일 복사 정상, (c) 트레이/아이콘 생성 정상, (d) 상주 PowerShell 도우미 정상(활성 창 감지 로그 확인), (f) `claude` 탐색 정상(VS Code 확장 바이너리) 및 실제 대화 think→talk→done, 설정 창 표시. 제거 후 설치 폴더와 레지스트리 항목 잔여물 없음.
   - 아이콘은 default 스킨에서 만든 임시 `build/icon.png`(`npx electron tools/make-icon.cjs`). 최종 캐릭터가 정해지면 교체.
   - 개발 환경 주의: 셸에 `ELECTRON_RUN_AS_NODE=1`이 설정돼 있으면(예: VS Code 터미널) `npx electron`/`electron-builder` 실행이 일반 Node로 동작해 실패한다. `env -u ELECTRON_RUN_AS_NODE`로 해제하고 실행한다.
   - **남은 확인**: (e) 설치본의 "로그인 시 자동 시작" 등록(시스템 설정을 바꿔서 확인하지 않음), **코드 서명 없음**(SmartScreen 경고, 배포 시 인증서 필요), 다른 PC·깨끗한 계정에서의 설치, 자동 업데이트 없음, macOS 빌드는 미작업. (사용자 스킨 폴더는 구현함: 5.4 "스킨 위치")
2. **첫 실행 안내** (11장): 연결 종류 선택(구독/API 키/무료·로컬), 종류별 설치·로그인 단계, CLI 자동 감지, Gemini 무료 키 프리셋. Gemini CLI 안내 문구 재검토.
3. **API 연결의 도구 루프** (후순위, 규모 큼): 현재 Anthropic API/OpenAI 호환 연결은 대화만 가능하다. 앱이 읽기/검색/쓰기/명령 도구를 정의하고 작업 폴더 안에서만 실행하며, 쓰기·명령은 기존 승인 카드로 묻는다. 어댑터별 도구 호출 형식 변환과 경로 검증 테스트가 필요하다. 이후 Codex/Gemini CLI의 읽기 전용 제한 해제(각 CLI의 승인 프로토콜 검증 후)도 검토.
4. **(보류) Antigravity CLI(`agy`) 연결** — 필요할 때 진행. 2026-06-18부터 개인 Google 계정의 Gemini CLI 이용이 종료되어(사용자 PC에서 `IneligibleTierError`로 확인) 그 후속인 Antigravity CLI를 연결하는 작업이다. 코드 규모는 Codex/Gemini 어댑터(각 약 180줄)와 비슷하지만, **착수 전에 아래를 먼저 확인해야 한다.** 이 PC에는 `agy`가 설치되어 있지 않다.
   - 알려진 것(검색, 대부분 제3자 자료): 비대화 실행 `agy -p`, `--output-format text|json|stream-json`, `--input-format text|stream-json`(stdin), `--print-timeout`(기본 5분), 로그인은 대화형으로 한 번 해 두면 캐시된 자격증명 사용. 공식 문서: https://antigravity.google/docs/cli/headless
   - 무료: 개인(Individual) 플랜 $0, 탭 완성/명령은 무제한, **에이전트 작업은 주간 할당량**(수치 비공개, 검색 같은 도구 사용은 더 빨리 닳을 가능성, 무료는 금방 소진된다는 후기). 유료 Google AI Pro/Ultra는 5시간 단위 갱신.
   - 확인할 것 (막힐 수 있음): ① **읽기 전용 실행 옵션**이 있는가(Codex `--sandbox read-only`, Gemini `--approval-mode plan`에 해당). 없으면 안전하게 연결할 수 없고, 승인 중계 설계가 필요해 작업이 훨씬 커진다. ② `stream-json` 이벤트 구조(텍스트 조각, 도구 사용, 오류). ③ 프롬프트를 stdin(`--input-format stream-json`)으로 보낼 수 있는가(`-p`로 프롬프트를 주면 stdin을 읽지 않는다는 보고가 있음; 앱 원칙은 사용자 입력을 인자로 넘기지 않는 것). ④ 모델/말투(시스템 프롬프트) 지정 방법(`--model` 없음 보고). ⑤ 파이프로 실행할 때 출력이 비는 알려진 버그(https://github.com/google-antigravity/antigravity-cli/issues/76, 1.1.1에서 수정됐다고 하나 미검증)가 설치 버전에서 해결됐는가. ⑥ 계정 자격 오류("이 계정은 Antigravity를 쓸 수 없다")가 나는가.
   - 시작 방법: 사용자가 `agy`를 설치·로그인한 뒤 `agy --help`와 `agy -p "한 문장으로 인사해" --output-format stream-json` 결과를 확인한다. ①이 안 되면 대화·검색 전용(도구 끄기) 옵션을 찾아보고, 그것도 없으면 연결을 보류한다.
   - 대안: 무료로 대화+검색이 목적이면 Codex(ChatGPT 무료 계정, 이미 지원)가 지금 가장 현실적이다. Gemini API 무료 키 + Google 검색 연결(grounding) 어댑터도 후보(OpenAI 호환 연결은 검색 기능을 켜 주지 못한다).
5. 알려진 제약: 쉬기/정시 알림은 첫 번째 펫만 말함, 펫끼리 겹침 회피 없음, 외부 서버/계정과의 실제 통신은 가짜 서버 기반으로만 검증, 구독 계정의 CLI 호출이 각 제공사 약관에 맞는지 미확인.

