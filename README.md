# dozy-agent-wiki

사내 AI 에이전트가 공통으로 참조하는 org/project/personal 3단 계층 LLM Wiki (MCP 기반, 단일 인스턴스).

전체 설계는 [`docs/spec.md`](./docs/spec.md) 참조. 구현 시 AI 에이전트가 참조할 지침은 [`AGENTS.md`](./AGENTS.md) (도구 공통 표준). `CLAUDE.md`는 이를 임포트하는 Claude Code 전용 진입점.

## 구조

```
packages/mcp-server/   # Fastify + MCP SDK 서버
packages/wiki-cli/     # mcp / push / login / whoami 서브커맨드
docker-compose.yml
```

## 시작하기

```bash
npm install
cp .env.example .env   # 값 채우기
npm run dev:server      # mcp-server 개발 서버
npm run dev:cli -- mcp   # wiki-cli 로컬 실행
```

## Git 워크플로우

### 브랜치 전략

- `main`은 항상 배포 가능한 상태를 유지한다. 직접 커밋하지 않는다.
- 작업은 `feature/`, `fix/`, `chore/` 등 접두사를 붙인 브랜치에서 진행한다 (예: `feature/mcp-search-tool`).
- 작업이 끝나면 `main`을 대상으로 PR을 열고, 병합은 **squash merge**로 한다.

### 커밋 컨벤션

[Conventional Commits](https://www.conventionalcommits.org/)의 축약형을 따른다.

| 타입 | 용도 |
|---|---|
| `feat` | 새 기능 |
| `fix` | 버그 수정 |
| `chore` | 빌드/설정/의존성 등 코드 동작과 무관한 변경 |
| `docs` | 문서만 변경 |
| `refactor` | 동작 변화 없는 리팩터링 |
| `test` | 테스트 추가/수정 |

예: `feat: add search tool to mcp-server`
