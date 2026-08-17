# dozy-agent-wiki

사내 AI 에이전트(Claude Code, Cursor, Codex 등)가 공통으로 참조하는 org/project/personal 3단 계층 LLM Wiki. MCP 기반, 단일 인스턴스.

이 파일은 도구에 관계없이 모든 AI 코딩 에이전트가 참조하는 표준 지침 파일이다. 도구별 지침 파일(`CLAUDE.md` 등)은 이 파일을 임포트해서 쓴다.

## 반드시 먼저 읽을 것

**모든 설계 결정과 스키마, tool 명세는 `docs/spec.md`를 기준으로 한다.** 새 기능을 추가하거나 구조를 바꿀 때는 이 문서를 먼저 갱신하고 코드를 짠다. 이 문서와 코드가 어긋나면 `docs/spec.md`가 우선한다.

## 스택

- 언어: TypeScript (Node.js) — CLI/서버 통일
- 서버: Fastify + `@modelcontextprotocol/server`/`node`(v2 SDK) + `@modelcontextprotocol/fastify`(어댑터), Streamable HTTP
- DB: PostgreSQL 18
- 인증: GitHub OAuth App (리소스 서버 패턴, 자체 로그인 없음)
- 리버스 프록시: Caddy
- 배포: 단일 VM + docker-compose

## 구조

```
packages/mcp-server/   # Fastify 기반 MCP 서버 (search/read/write/... tool)
packages/wiki-cli/     # 단일 CLI, 서브커맨드: mcp / push / login / whoami
docs/spec.md           # 소스 오브 트루스
docker-compose.yml
```

## 지금 구현 단계 — 1차 구현 (docs/spec.md §8 참조)

- [ ] Postgres 스키마 마이그레이션 (§3.2)
- [ ] MCP tool: `search`, `read`, `list_kbs`
- [ ] `write` shorthand (단일 페이지, `expected_version` 비교 포함)
- [ ] GitHub OAuth 토큰 검증 미들웨어 + `permission_cache`
- [ ] KB 즉석 자동 생성 (`_index`, `_log` 포함, §4.4)
- [ ] `wiki-cli mcp` 서브커맨드 (stdio, git remote 파싱 → `X-Repo` 헤더)
- [ ] `wiki-cli login` 서브커맨드 (GitHub OAuth, 토큰 캐시)

2차/3차 구현 범위는 `docs/spec.md` §8을 참조.

## 코딩 컨벤션

- `wiki-cli mcp` 서브커맨드는 stdout에 JSON-RPC만 흘러야 하므로, 이 경로의 모든 로그는 stderr로만 출력한다 (§4.2 참조).
- 세션 커밋(`commit_session`)의 충돌 감지는 KB 전체가 아니라 **건드린 slug만** 비교한다 — `FOR UPDATE` + slug 알파벳순 잠금으로 데드락을 피한다 (§4.6).
