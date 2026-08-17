# 사내 LLM Wiki 시스템 명세서 (v2)

## 1. 개요

### 1.1 배경
여러 AI 에이전트(Claude Code, Cursor, Codex 등)가 작업 시 참조해야 할 지식이 두 종류로 나뉜다.
- 조직 전체가 지켜야 하는 공용 컨벤션/정책
- 프로젝트 및 개인 단위의 작업 맥락

기존 방식(프로젝트마다 설정 파일 복붙, 여러 인스턴스 분산 운영)은 새 프로젝트를 만들 때마다 반복 작업이 필요하다는 문제가 있었다.

### 1.2 목표
- **단일 인스턴스**에서 조직/프로젝트/개인 3단 계층을 관리한다.
- 개발자는 **전역 설정을 한 번**만 하면, 이후 어떤 프로젝트를 열어도 자동으로 알맞은 지식 공간에 연결된다.
- 권한 관리는 **GitHub 권한을 그대로 재사용**하고 별도 사용자/권한 시스템을 만들지 않는다.
- 여러 AI 에이전트 툴에서 공통으로 접근 가능해야 한다 (MCP 프로토콜 기반).
- 자동 누적(에이전트 write)과 신중한 변경(사람 리뷰)이 **같은 KB 안에서도 공존**할 수 있어야 한다.

### 1.3 비목표 (MVP 범위 밖)
- 벡터 검색 / 임베딩 기반 RAG (문서량이 커지기 전까지 불필요)
- 실시간 협업 편집, 웹 기반 리치 에디터
- GitHub 외 SSO/IdP 연동

---

## 2. 시스템 아키텍처

```
[개발자 머신]                                [클라우드 VM 1대]
┌────────────────────┐   Streamable HTTP    ┌───────────────────────────┐
│ AI 에이전트          │   + Bearer(GH 토큰)   │ Caddy (reverse proxy, TLS) │
│ (Claude/Cursor/Codex)│ ────────────────────▶│  └─ MCP 서버 (TS/Fastify)   │
│                      │   X-Repo 헤더        │        ├─ Postgres         │
│ wiki-cli mcp         │                      │        └─ GitHub API 연동   │
│ (전역 등록, 1회)      │                      │           (권한 검증)       │
└────────────────────┘                      └───────────────────────────┘
        ▲
        │  (사람이 직접 md 업로드 시)
┌────────────────────┐
│ wiki-cli push        │  → 동일한 API를 재사용 (§4.5)
└────────────────────┘
```

> `wiki-cli`는 단일 패키지, 서브커맨드로 역할이 나뉜다: `mcp`(stdio MCP 서버, 에이전트 연결용), `push`(사람이 직접 md 업로드), `login`/`whoami`(인증) — §4.2 참조.

### 2.1 계층 구조 (Knowledge Base)

| KB 유형 | id 형식 | 관리 주체 | 예시 |
|---|---|---|---|
| org | `"org"` | 위키 전체 관리자 | 전사 컨벤션, 정책 |
| project | `"<owner>/<repo>"` | 해당 repo 관리자 (GitHub 권한 상속) | `myteam/backend-api` |
| personal | `"<owner>/<repo>:<github_user>"` | 본인만 | `myteam/backend-api:junho` |

동일한 Postgres DB, 동일한 MCP 서버 안에서 `kb_id` 컬럼으로 논리적으로만 구분된다. 물리적으로 별도 인스턴스를 두지 않는다.

---

## 3. 데이터 모델

### 3.1 KB 내부 구성

파일시스템은 없지만 `slug`를 `/`로 구분된 경로처럼 사용해 가벼운 폴더 구조를 흉내낸다.

```
conventions/coding-style
architecture/auth-flow
troubleshooting/db-timeout-2026-08
```

**모든 KB 공통 예약 페이지** — KB 생성 시 자동으로 빈 페이지로 함께 만들어짐.

| slug | 역할 | 쓰기 방식 |
|---|---|---|
| `_index` | 이 KB에 어떤 문서가 있는지 목차/네비게이션 | write 시마다 자동 갱신 또는 nightly routine이 재생성 |
| `_log` | append-only 변경 이력 요약 | `append` tool 전용, 사람이 최근 변경사항을 훑을 때 사용 |

**KB 타입별 관습**

| KB | 구성 방식 |
|---|---|
| org | 관리자가 사전에 정한 고정 카테고리 (`conventions/`, `policies/`, `glossary/`) |
| project | 자유롭게 증가, 그 중 일부 경로만 `protected_patterns`로 보호 (§4.7) |
| personal | 구조 규칙 없음, 완전 자유 |

### 3.2 스키마

```sql
CREATE TABLE knowledge_bases (
  id            text PRIMARY KEY,      -- "org" | "owner/repo" | "owner/repo:user"
  type          text NOT NULL,         -- 'org' | 'project' | 'personal'
  parent_id     text REFERENCES knowledge_bases(id),
  created_at    timestamptz DEFAULT now(),
  archived      boolean DEFAULT false
);

CREATE TABLE pages (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kb_id         text REFERENCES knowledge_bases(id),
  slug          text NOT NULL,
  category      text GENERATED ALWAYS AS (split_part(slug, '/', 1)) STORED,
  title         text NOT NULL,
  content_md    text NOT NULL,
  version       bigint NOT NULL DEFAULT 1,   -- 페이지별 버전, 커밋 시 충돌 감지용 (§4.6)
  search_vec    tsvector GENERATED ALWAYS AS (to_tsvector('simple', content_md)) STORED,
  updated_by    text,                  -- github_user
  updated_at    timestamptz DEFAULT now(),
  deleted_at    timestamptz,           -- soft-delete (§4.6)
  UNIQUE (kb_id, slug)
);

CREATE TABLE edit_sessions (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kb_id         text REFERENCES knowledge_bases(id),
  opened_by     text,                    -- github_user
  status        text DEFAULT 'open',     -- open | committed | conflict | aborted | expired
  opened_at     timestamptz DEFAULT now(),
  expires_at    timestamptz DEFAULT now() + interval '30 minutes'
);

CREATE TABLE session_changes (
  id                bigserial PRIMARY KEY,
  session_id        uuid REFERENCES edit_sessions(id),
  slug              text NOT NULL,
  action            text,                -- 'write' | 'append' | 'delete'
  content_md        text,
  expected_version  bigint NOT NULL,      -- read()로 받았던 버전, 없던 페이지면 0
  created_at        timestamptz DEFAULT now()
);

CREATE TABLE pages_history (
  id            bigserial PRIMARY KEY,
  kb_id         text,
  slug          text,
  content_md    text,          -- 변경/삭제 직전 내용
  action        text,          -- 'write' | 'append' | 'delete' | 'revert'
  changed_by    text,
  changed_at    timestamptz DEFAULT now()
);

CREATE TABLE protected_patterns (
  kb_id         text,
  pattern       text,          -- 예: "conventions/**", "architecture/decisions"
  mode          text DEFAULT 'block',  -- 'block' | 'notify' (§4.7)
  PRIMARY KEY (kb_id, pattern)
);

CREATE TABLE pages_draft (
  id            bigserial PRIMARY KEY,
  kb_id         text,
  slug          text,
  content_md    text,
  proposed_by   text,
  status        text DEFAULT 'pending',  -- pending | approved | rejected
  reviewed_by   text,
  created_at    timestamptz DEFAULT now()
);

CREATE TABLE permission_cache (
  github_user   text,
  repo_slug     text,
  permission    text,                  -- read | triage | write | maintain | admin
  expires_at    timestamptz,
  PRIMARY KEY (github_user, repo_slug)
);

CREATE TABLE kb_versions (
  kb_id         text PRIMARY KEY REFERENCES knowledge_bases(id),
  version       bigint NOT NULL DEFAULT 0
  -- KB 전체 워터마크. stale 감지 전용(§3.3) — 커밋 충돌 감지(§4.6)는 pages.version을 따로 씀
);

CREATE TABLE audit_log (
  id            bigserial PRIMARY KEY,
  github_user   text,
  kb_id         text,
  action        text,                  -- read | write | delete | admin_override
  at            timestamptz DEFAULT now()
);
```

### 3.3 버전 관리 (stale 감지)

로컬 에이전트가 세션 중 "내가 읽어둔 내용이 여전히 최신인지"를 저비용으로 확인할 수 있어야 한다. 페이지 단위가 아니라 **KB 단위의 워터마크(버전 카운터)**로 처리한다 — B안 채택: 폴링 기반 stale 감지만 다루고, 동시 쓰기 충돌 방지(페이지별 낙관적 잠금)는 이번 범위에서 제외한다.

**신규 tool**
```
get_kb_version(kb_id) → { version: 42 }
```

**사용 흐름**
1. 에이전트가 세션 시작 시 특정 KB를 읽고 그 시점의 `version`을 로컬(또는 `wiki-cli mcp` 프로세스 내)에 기록해둔다.
2. 세션 중 중요한 판단(특히 protected 문서 기준 판단) 전에 `get_kb_version(kb_id)`을 가볍게 호출.
3. 값이 바뀌었으면 관련 페이지만 다시 `read`하여 최신 내용 반영.

**응답 스키마 변경** — `read`/`search` 응답에 해당 페이지가 속한 KB의 현재 `version`을 함께 반환해, 에이전트가 자신이 참조 중인 내용이 몇 번째 버전 기준인지 항상 추적할 수 있게 한다.

> MCP 프로토콜의 리소스 구독(push 알림) 방식도 검토했으나, 클라이언트별 구현 신뢰도와 세션 특성(툴 호출 단위로 짧게 끊김)을 고려해 채택하지 않는다.

---

## 4. 컴포넌트 상세

### 4.1 MCP 서버

- 전송 방식: **Streamable HTTP** (현재 MCP 표준 원격 전송)
- 역할: OAuth 2.1 **리소스 서버**로만 동작 — 자체 로그인/토큰 발급 없음, GitHub이 발급한 토큰을 검증만 함

| Tool | 설명 | 필요 권한 |
|---|---|---|
| `search(query, kb_scope?)` | org/project/personal 통합 또는 지정 검색 | read |
| `read(kb_id, slug)` | 페이지 조회, `version` 포함 반환 | read |
| `list_pages(kb_id, prefix?)` | slug 목록 조회 (카테고리 그룹핑) | read |
| `list_kbs()` | 현재 유저가 접근 가능한 KB 목록 | - |
| `get_kb_version(kb_id)` | KB의 현재 버전 워터마크 조회 (stale 감지) | read |
| `open_session(kb_id)` | 편집 세션 시작 → `session_id` 발급 | write |
| `stage_write(session_id, slug, content, expected_version)` | 세션에 전체 교체 변경사항 기록 (아직 미반영) | write |
| `stage_append(session_id, slug, content, expected_version)` | 세션에 append 변경사항 기록 | write |
| `stage_delete(session_id, slug, expected_version)` | 세션에 삭제 변경사항 기록 | write/삭제 권한 |
| `commit_session(session_id)` | 세션에 쌓인 변경사항을 한 트랜잭션으로 반영, 충돌 시 거부 (§4.6) | write |
| `abort_session(session_id)` | 세션 폐기 | - |
| `write(kb_id, slug, content, expected_version)` | **shorthand**: 단일 페이지 open+stage_write+commit | write |
| `append(kb_id, slug, content, expected_version)` | **shorthand**: 단일 페이지 open+stage_append+commit | write |
| `delete(kb_id, slug, expected_version)` | **shorthand**: 단일 페이지 open+stage_delete+commit | §5.1 참조 (KB별 상이) |
| `revert(kb_id, slug, history_id)` | 이전 버전으로 복원 (페이지 버전도 함께 증가) | write |
| `lint(kb_id)` | 깨진 링크/고아 페이지 점검 | read |

여러 페이지를 하나의 논리적 변경으로 묶으려면(예: nightly routine이 여러 문서를 한 번에 정리) `open_session` → 여러 번의 `stage_*` → `commit_session` 흐름을 쓴다. 단일 페이지만 바꿀 때는 `write`/`append`/`delete` shorthand로 충분하다.

기본 검색은 벡터DB 없이 Postgres `tsvector` full-text로 처리 (§1.3 비목표 참조).

### 4.2 wiki-cli (단일 패키지, 서브커맨드로 역할 분리)

클라이언트 쪽 로직(repo 식별, 토큰 로드/검증, API 클라이언트)을 **하나의 패키지**로 통합하고, 역할은 서브커맨드로만 나눈다.

| 서브커맨드 | 역할 | 실행 주체 |
|---|---|---|
| `wiki-cli mcp` | stdio 기반 로컬 MCP 서버로 동작 — Claude Code 등 에이전트가 자식 프로세스로 실행 | 에이전트가 세션마다 자동 실행 |
| `wiki-cli push <file> --kb <kb_id>` | 사람이 md 파일을 직접 업로드 (§4.5) | 사람이 터미널에서 직접 실행 |
| `wiki-cli login` | GitHub OAuth 로그인, 토큰을 OS 키체인에 저장 | 최초 1회, 사람이 직접 |
| `wiki-cli whoami` | 현재 로그인 상태/권한 진단 | 필요시 |

**`mcp` 서브커맨드 동작 (에이전트 연결용)**
- 각 개발자 머신에 **전역으로 1회만 등록**: `claude mcp add --scope user company-wiki -- npx wiki-cli mcp`
- 매 tool 호출 시:
  1. 현재 작업 디렉토리에서 `git remote get-url origin` → repo 식별자 추출
  2. OS 키체인에 저장된 GitHub 토큰(`login` 서브커맨드가 저장) 로드
  3. 실제 MCP 서버로 HTTP 요청 전달 (`X-Repo`, `Authorization` 헤더 첨부)
- 이 컴포넌트 덕분에 **프로젝트 디렉토리 자체에는 아무 설정 파일도 필요 없음**.

**구현 시 주의점** — `mcp` 서브커맨드는 stdout으로 JSON-RPC를 주고받으므로, 이 모드에서는 모든 로그를 stderr로만 출력해야 한다 (stdout에 다른 텍스트가 섞이면 프로토콜이 깨짐). `push`/`login`/`whoami` 등 일반 서브커맨드는 이 제약이 없다.

- 배포: npm/pip 패키지로 배포, `npx wiki-cli <subcommand>` 또는 `pipx install wiki-cli` 한 줄로 설치.

### 4.3 인증

- `wiki-cli login`으로 최초 1회 GitHub OAuth 로그인 → 토큰을 평문 파일이 아닌 **OS 키체인**(macOS Keychain / Windows Credential Manager / libsecret 등, 플랫폼별 credential store)에 저장.
- 서버는 매 요청마다 토큰의 유효성을 GitHub `GET /user`로 검증 (결과는 짧은 TTL로 캐시).
- 서비스 계정(nightly routine 등 자동화 작업)은 GitHub App 설치 토큰을 별도로 사용 — 개인 PAT와 credential을 분리한다.

### 4.4 프로비저닝 (자동 생성)

| 트리거 | 동작 |
|---|---|
| 특정 repo에 대한 project KB가 아직 없는 상태에서 첫 요청 발생 | 요청 처리 전 project KB 즉석 생성 (`_index`, `_log` 포함) |
| 특정 유저의 personal KB가 아직 없는 상태에서 첫 요청 발생 | 요청 처리 전 personal KB 즉석 생성 (parent = project KB) |
| (선택, MVP 이후) GitHub `repository.created` 웹훅 | project KB를 미리 생성 — 즉석 생성만으로 충분하면 생략 가능 |

### 4.5 콘텐츠 인입 경로 (사람이 직접 md 업로드)

MCP `write`는 에이전트를 통해서만 호출되므로, 사람이 파일을 직접 넣는 경로를 별도로 둔다. `write`가 쓰는 **동일한 내부 함수를 재사용**하는 얇은 API 하나만 추가한다 — DB에 직접 접근할 필요는 없다.

```
POST /api/kb/{kb_id}/pages
Authorization: Bearer <github_token>   ← 기존 권한 체크 미들웨어 그대로 재사용
Content-Type: multipart/form-data
file: conventions.md
```

```bash
wiki-cli push conventions.md --kb org
wiki-cli push docs/*.md --kb org       # 여러 파일 일괄
```

- 이 경로도 §4.7의 `protected_patterns` 매칭을 그대로 통과한다 (권한/보호 로직은 진입 경로와 무관하게 동일 적용).
- 2차 구현: 같은 API를 호출하는 최소 웹 업로드 페이지 (§8 참조).

### 4.6 편집·삭제, 동시 편집 세션, 버전 이력

**개별 변경 방식**
- `write`(shorthand 또는 세션의 `stage_write`)는 전체 교체(upsert), `append`는 기존 내용 뒤에 추가만 — 부분 수정 의도인데 전체를 날리는 사고를 방지.
- 모든 변경 직전에 변경 전 상태를 `pages_history`에 기록 (§3.2).
- `revert(kb_id, slug, history_id)` tool로 특정 시점 내용으로 즉시 복원 가능 (페이지 `version`도 함께 증가).
- 삭제는 KB 유형별로 문턱이 다르다 (§5.1).

**동시 편집 세션 모델**

여러 페이지를 하나의 논리적 변경으로 묶고, 그 사이 다른 누군가 같은 페이지를 먼저 바꿔버리는 걸 막기 위해 git과 비슷한 open → stage → commit 흐름을 쓴다.

```
open_session(kb_id) → { session_id }
stage_write(session_id, slug, content, expected_version)   -- 여러 번 반복 가능
stage_append(session_id, slug, content, expected_version)
stage_delete(session_id, slug, expected_version)
commit_session(session_id) → { status: "committed" } | { status: "conflict", conflicts: [...] }
abort_session(session_id)
```

`expected_version`은 클라이언트가 이전에 `read()`로 실제로 받았던 `pages.version` 값을 그대로 되돌려주는 것이다 (HTTP의 ETag/If-Match와 같은 발상). 이걸 세션이 자체 판단하지 않고 클라이언트가 명시적으로 넘기게 해야 "내가 실제로 본 내용 기준으로" 충돌을 검증하는 진짜 낙관적 잠금이 된다.

**커밋 로직 — 건드린 페이지만, 통일된 비교식으로 검증**

```python
def commit_session(session_id):
    session = get_session(session_id)
    changes = get_session_changes(session_id)
    touched_slugs = sorted(set(c.slug for c in changes))  # 알파벳순 정렬 후 잠금 → 데드락 방지

    with db.transaction():
        conflicts = []
        for slug in touched_slugs:
            row = db.execute(
                "SELECT version FROM pages WHERE kb_id=%s AND slug=%s FOR UPDATE",
                [session.kb_id, slug]
            )
            current = row.version if row else 0          # 페이지가 없으면 0 (신규/삭제됨 통일 처리)
            expected = get_expected_version(session_id, slug)
            if current != expected:
                conflicts.append({"slug": slug, "expected": expected, "current": current})

        if conflicts:
            db.rollback()
            return {"status": "conflict", "conflicts": conflicts}

        # protected_patterns에 하나라도 걸리면 전체를 draft로 (§4.7)
        if any(matches_protected(session.kb_id, c.slug) for c in changes):
            move_all_to_draft(session.kb_id, changes)
        else:
            for c in changes:
                apply_change(session.kb_id, c)             # 각 페이지 version += 1, pages_history 기록
            db.execute("UPDATE kb_versions SET version = version + 1 WHERE kb_id=%s", [session.kb_id])

        mark_committed(session_id)

    return {"status": "committed"}
```

`current != expected` 하나의 비교식으로 수정·삭제·신규생성 세 경우를 모두 처리한다:

| 상황 | current | expected | 결과 |
|---|---|---|---|
| 새 페이지 생성 (원래 없음) | 0 | 0 | 충돌 아님 |
| 정상 수정 | 7 | 7 | 충돌 아님 |
| 읽은 뒤 다른 사람이 먼저 수정 | 8 | 7 | 충돌 |
| 읽은 뒤 다른 사람이 삭제 | 0 | 7 | 충돌 |

**설계 근거**
- 비교 범위를 KB 전체가 아니라 **이 세션이 실제로 건드린 slug만**으로 좁혀, 서로 겹치지 않는 페이지를 고친 세션끼리 불필요하게 충돌 처리되는 false positive를 없앤다.
- `FOR UPDATE` row lock + slug 알파벳순 잠금으로 동시 커밋 시 TOCTOU(check-then-act) 문제와 데드락을 방지한다.
- 세션은 `expires_at`(기본 30분) TTL로 자동 만료 처리 — 방치된 세션이 변경사항을 잠그고 있는 게 아니라 그냥 커밋되지 않은 채로 남는 것뿐이라, 방치돼도 다른 사람 작업을 막지 않는다.
- 세션에 protected 경로가 하나라도 섞여 있으면 v1에서는 전체를 통째로 draft로 보낸다 (일반/protected 분리는 필요시 이후 정교화).

이 세션 충돌 검증(`pages.version`)은 §3.3의 `kb_versions`(stale 감지)와 별개 메커니즘이다 — 전자는 "커밋해도 되는가"를 판단하고, 후자는 "에이전트가 들고 있는 기억이 오래됐는가"를 판단한다.

### 4.7 콘텐츠 보호 (Protection)

KB 전체가 아니라 **경로 패턴 단위**로 신중한 처리를 강제한다 — GitHub CODEOWNERS의 경로 매칭과 동일한 발상. org/project 모두 같은 메커니즘으로 처리하므로 별도의 git 레포·sync job이 필요 없다.

**동작 규칙**

| slug 매칭 | commit_session 시 동작 |
|---|---|
| `protected_patterns`에 매칭 안 됨 | 즉시 반영 (history는 항상 남음) |
| 매칭됨, `mode='block'` | 세션 전체가 `pages_draft`에 pending으로 들어가고, 승인권자가 approve 해야 `pages`에 반영 |
| 매칭됨, `mode='notify'` | 즉시 반영하되 승인권자에게 diff 알림 → 문제 시 `revert`로 사후 정정 |

**KB별 기본 패턴 및 승인권자**

| KB | 기본 protected 범위 | 승인권자 |
|---|---|---|
| org | 전체 경로 (`**`), 기본 `mode='block'` | wiki-admins |
| project | 관리자가 지정한 일부 경로만 (예: `architecture/**`, `conventions`) | repo admin |
| personal | 보호 불가 (patterns 등록 금지) | 해당 없음 |

---

## 5. 권한 모델

### 5.1 매핑 규칙

| KB | 읽기 | 쓰기(비보호 경로) | 삭제 |
|---|---|---|---|
| org | GitHub 조직 멤버 전체 | wiki-admins (전체가 protected라 사실상 draft 경유) | wiki-admins, soft-delete + 완전 삭제는 수동 배치 |
| project | repo에 read 이상 권한 보유자 | repo에 write 이상 권한 보유자 | repo **admin**, soft-delete(30일 보관) |
| personal | 본인만 | 본인만 | 본인, 즉시 삭제 |

### 5.2 검증 흐름

```
1. Authorization 헤더 → GitHub 토큰 검증 → github_user 확정
   (클라이언트가 보낸 식별값은 신뢰하지 않고 토큰에서만 identity 도출)
2. 요청 대상 kb_id 확인
3. kb.type별 권한 규칙 적용 (§5.1)
4. project KB의 경우 permission_cache 조회, 없으면 GitHub API 호출 후 짧은 TTL로 캐시
5. write/delete인 경우 protected_patterns 매칭 확인 (§4.7) → draft 경유 여부 결정
6. 허용/거부 결정 → audit_log 기록
```

### 5.3 예외 처리

| 상황 | 처리 |
|---|---|
| repo에서 collaborator 제거 | 캐시 만료(TTL) 후 자동 차단 |
| repo 삭제 | KB 즉시 삭제하지 않고 `archived=true` 처리 (감사 목적 보존) |
| 관리자의 개인 KB 감사 필요 시 | 기본 차단, `admin_override` action으로만 예외 허용 + 로그 필수 |

---

## 6. 배포

### 6.1 인프라

- 단일 VM (예: AWS `t3.small`, DigitalOcean Basic Droplet — vCPU 2 / RAM 4GB)
- docker-compose 구성 요소: `postgres`, `mcp-server`, `caddy`
- 벡터DB/오브젝트스토리지(S3, MinIO) 불필요 — Postgres 하나로 본문+검색 해결
- 예상 비용: 월 $10~20 수준

### 6.2 docker-compose 서비스 구성 (요약)

```yaml
services:
  postgres:
    image: postgres:18
    volumes: [pgdata:/var/lib/postgresql/data]
  mcp-server:
    build: ./mcp-server
    environment:
      - DATABASE_URL=postgresql://...
      - GITHUB_OAUTH_CLIENT_ID=...
      - GITHUB_OAUTH_CLIENT_SECRET=...
    depends_on: [postgres]
  caddy:
    image: caddy:2
    ports: ["443:443"]
    volumes: [./Caddyfile:/etc/caddy/Caddyfile]
```

---

## 7. 기술 스택 요약

| 영역 | 선택 | 비고 |
|---|---|---|
| 언어 | TypeScript (Node.js) | CLI(`wiki-cli`)와 서버 모두 통일 — 빠른 프로세스 시작(세션마다 재실행되는 `wiki-cli mcp`에 유리) |
| MCP 프로토콜 | 공식 SDK v2 (모듈 분리) — `@modelcontextprotocol/server`(`McpServer`, stdio), `@modelcontextprotocol/node`(Streamable HTTP transport), `@modelcontextprotocol/client`(wiki-cli의 원격 relay) | v1 `@modelcontextprotocol/sdk`(모놀리식)는 deprecated, 신규 프로젝트는 v2로 시작 |
| 웹 프레임워크 | Fastify + `@modelcontextprotocol/fastify`(공식 어댑터) | 어댑터는 Fastify 앱 생성 + DNS rebinding/Origin 헤더 보호만 제공 — tool 등록·transport 연결은 `@modelcontextprotocol/server`/`node`를 직접 사용 |
| DB | Postgres 18 | 본문 저장 + full-text 검색 + 권한 캐시 + 이력/draft |
| 인증 | GitHub OAuth App | 별도 IdP 불필요 |
| 리버스 프록시/TLS | Caddy | 자동 HTTPS |
| 클라이언트/인입 | wiki-cli (자체 개발, 단일 패키지 · `mcp`/`push`/`login` 서브커맨드) | 전역 1회 등록, 진입 경로 무관하게 동일 API 재사용 |
| 배포 | 단일 VM + docker-compose | 클러스터 불필요 |

---

## 8. MVP 범위

**1차 구현 (필수)**
- MCP 서버: `search`, `read`, `write`(shorthand), `list_kbs` 4개 tool
- Postgres 스키마 (§3.2, `pages.version` 포함) + GitHub 토큰 검증 + 권한 캐시
- `wiki-cli mcp` 서브커맨드 (로컬 MCP 클라이언트)
- KB 즉석 자동 생성 로직 (`_index`, `_log` 포함)
- 단일 페이지 커밋 시 `expected_version` 비교 (충돌 감지 최소 버전)

**2차 구현**
- `append`, `delete`, `revert`, `list_pages`, `lint`, `get_kb_version` tool
- `open_session`/`stage_write`/`stage_append`/`stage_delete`/`commit_session`/`abort_session` (다중 페이지 원자적 커밋)
- `pages_history` 이력 기록
- `kb_versions` 워터마크 + `read`/`search` 응답에 `version` 포함
- `protected_patterns` + `pages_draft` 승인 흐름 (block/notify)
- `wiki-cli push`/`login`/`whoami` 서브커맨드
- nightly 자동 컴파일 routine (원본 자료 → wiki 반영)
- GitHub 웹훅 기반 사전 프로비저닝

**3차 구현**
- 간단한 조회/업로드 웹 UI
- 다른 에이전트 툴(Cursor, Codex)용 `wiki-cli mcp` 등록 가이드

---

## 9. 미해결 이슈 / 향후 검토

- personal KB의 백업/보존 정책 (퇴사자 KB 처리 등)
- `pages_draft` 승인 알림 채널 (Slack/이메일) 연동 방식
- `mode='block'` vs `'notify'`를 어떤 기준으로 문서별로 정할지 (가이드라인 필요)
- 문서량이 커졌을 때 full-text 검색의 한계 — 벡터 검색 도입 시점 판단 기준
- 여러 에이전트 툴에서 `wiki-cli mcp` 등록 방식 통일 (Claude Code/Cursor/Codex 설정 위치가 다름)
- `pages_history`가 무한정 쌓일 때의 보관 주기 정책
- 만료된(`expired`) `edit_sessions`/`session_changes` 정리 배치 주기
- protected 경로와 일반 경로가 섞인 세션을 "전체 draft" 대신 부분 승인으로 정교화할지 여부 (v1은 전체 draft로 단순화)
- 세션 충돌(`current != expected`) 빈도가 실제로 얼마나 되는지 관찰 후, 재시도 UX(자동 재시도 vs 에이전트에게 안내)를 다듬을 필요
