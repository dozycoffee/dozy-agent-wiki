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

브랜치 전략, 커밋 컨벤션, PR 체크리스트 등 기여 방법은 [`CONTRIBUTING.md`](./CONTRIBUTING.md) 참조.
