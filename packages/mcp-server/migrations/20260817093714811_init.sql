-- Up Migration

-- docs/spec.md §3.2

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

-- Down Migration

DROP TABLE audit_log;
DROP TABLE kb_versions;
DROP TABLE permission_cache;
DROP TABLE pages_draft;
DROP TABLE protected_patterns;
DROP TABLE pages_history;
DROP TABLE session_changes;
DROP TABLE edit_sessions;
DROP TABLE pages;
DROP TABLE knowledge_bases;
