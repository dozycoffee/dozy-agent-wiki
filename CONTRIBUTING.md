# Contributing

## 브랜치 전략

- `main`은 항상 배포 가능한 상태를 유지한다. 직접 커밋하지 않는다.
- 작업은 `feature/`, `fix/`, `chore/` 등 접두사를 붙인 브랜치에서 진행한다 (예: `feature/mcp-search-tool`).
- 작업이 끝나면 `main`을 대상으로 PR을 열고, 병합은 **squash merge**로 한다.

## 커밋 컨벤션

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

## PR

- [PR 템플릿](.github/pull_request_template.md)의 체크리스트를 따른다.
- 설계/스키마/tool 명세가 바뀌면 `docs/spec.md`를 함께 갱신한다 (`AGENTS.md` 참조).
