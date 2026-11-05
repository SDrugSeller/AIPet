# AIPet
overlay pet that connected with AI Agent

> 🤖 **Made with AI** — 이 프로젝트의 설계와 코드는 AI(Claude)의 도움을 받아 작성되었습니다.
> This project was designed and written with the assistance of AI (Claude).

설계 문서: [docs/DESIGN.md](docs/DESIGN.md)

## 실행

```
npm install
npm start        # 실행 (종료: 트레이 또는 펫 우클릭 → 종료)
npm test         # 자동 테스트
npm run lint
```

- 펫을 **클릭**하면 말풍선 입력창이 열리고, **드래그**하면 옮길 수 있습니다.
- **트레이 아이콘**: 왼쪽 클릭은 펫 숨기기/보이기, 오른쪽 클릭은 메뉴(AI 연결 선택, 설정, 종료). 펫을 우클릭해도 같은 메뉴가 나옵니다.
- **설정**(메뉴 → 설정…): AI 연결 사용/경로/주소/모델/API 키, 도구 사용, 작업 폴더, 알림음, 로그인 시 자동 시작. 값은 바꾸는 즉시 저장되고 재시작해도 유지됩니다 (`%APPDATA%/aipet/settings.json`).
- AI 연결:
  - **Claude Code**: 공식 `claude` CLI를 설치하고 터미널에서 한 번 로그인해 두면 자동으로 감지합니다. (설정에서 지정한 경로 → PATH → 공식 설치 위치 → VS Code Claude Code 확장에 포함된 바이너리 순으로 탐색) 어떤 계정으로 동작하는지 설정 화면에 표시됩니다.
  - **Ollama / OpenAI 호환**: 기본 주소 `http://127.0.0.1:11434/v1`. 모델을 지정하지 않으면 서버의 첫 모델을 씁니다. API 키는 OS 보안 저장소(Electron `safeStorage`)에 암호화해 저장하며, 보안 저장소를 쓸 수 없으면 저장하지 않습니다. (대화 전용, 도구 없음)
- **권한**(Claude Code 도구 사용):
  - 에이전트는 설정한 **작업 폴더** 안에서만 일합니다 (기본: 앱 전용 폴더). 폴더 밖 경로는 묻지 않고 거부합니다.
  - 읽기 전용 도구(Read/Glob/Grep 등)는 자동 허용(설정에서 끌 수 있음). 파일 쓰기, 명령 실행, 네트워크는 **말풍선의 승인 카드**에서 허용/거부합니다.
  - 승인 요청이 오면 펫이 놀란 표정을 짓고 알림음이 납니다. 다른 앱을 쓰는 중이어도 포커스를 가져가지 않습니다.
- 환경변수(설정에 값이 없을 때의 기본값): `AIPET_CLAUDE_PATH`, `AIPET_OPENAI_BASE_URL`, `AIPET_OPENAI_MODEL`, `AIPET_OPENAI_KEY`, `AIPET_BACKEND`(`claude-code`|`openai-compat`)
- 디버그(`AIPET_DEBUG=1`): 히트박스 표시, 로그 출력. `AIPET_START_DISPLAY`, `AIPET_SLEEP_AFTER_SEC`, `AIPET_AUTOTEST_MSG`, `AIPET_OPEN_SETTINGS`, `AIPET_CAPTURE_DIR`
- 임시 스프라이트는 `node tools/gen-placeholder-skin.mjs`로 다시 만들 수 있습니다.
