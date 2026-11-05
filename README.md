# AIPet
overlay pet that connected with AI Agent

> 🤖 **Made with AI** — 이 프로젝트의 설계와 코드는 AI(Claude)의 도움을 받아 작성되었습니다.
> This project was designed and written with the assistance of AI (Claude).

설계 문서: [docs/DESIGN.md](docs/DESIGN.md)

## 실행

```
npm install
npm start        # 실행 (종료: 펫 우클릭 → 종료)
npm test         # 자동 테스트
npm run lint
```

- 펫을 **클릭**하면 말풍선 입력창이 열리고, **드래그**하면 옮길 수 있습니다. 우클릭 메뉴에서 AI 연결을 고릅니다.
- AI 연결(M3):
  - **Claude Code**: 공식 `claude` CLI를 설치하고 터미널에서 한 번 로그인해 두면 자동으로 감지합니다. (PATH → 공식 설치 위치 → VS Code Claude Code 확장에 포함된 바이너리 순으로 탐색)
  - **Ollama / OpenAI 호환**: 기본 주소 `http://127.0.0.1:11434/v1`. 모델을 지정하지 않으면 서버의 첫 모델을 씁니다.
  - 지금은 대화만 가능하며 파일/명령 도구는 꺼져 있습니다 (권한 승인 UI는 M4).
- 환경변수(설정 화면 전 임시): `AIPET_CLAUDE_PATH`, `AIPET_OPENAI_BASE_URL`, `AIPET_OPENAI_MODEL`, `AIPET_OPENAI_KEY`, `AIPET_BACKEND`(`claude-code`|`openai-compat`)
- 디버그(`AIPET_DEBUG=1`): 히트박스 표시, 로그 출력. `AIPET_START_DISPLAY`, `AIPET_SLEEP_AFTER_SEC`, `AIPET_AUTOTEST_MSG`, `AIPET_CAPTURE_DIR`
- 임시 스프라이트는 `node tools/gen-placeholder-skin.mjs`로 다시 만들 수 있습니다.
