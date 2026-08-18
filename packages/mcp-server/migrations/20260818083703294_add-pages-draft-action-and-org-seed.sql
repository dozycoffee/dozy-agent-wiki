-- Up Migration

-- docs/spec.md §4.7 — pages_draft에 action 컬럼 추가.
-- commit_session/write/append/delete가 protected_patterns(mode='block')에 걸리면
-- 최종 결과 상태(append/write는 fold된 최종 content_md로 통일, delete는 content_md
-- NULL + action='delete')를 pages_draft에 남긴다. action 없이 content_md IS NULL을
-- "삭제 제안"의 sentinel로 쓰는 방법도 가능했지만(빈 문자열 ''도 유효한 페이지
-- 콘텐츠라 구분은 되지만), 승인자가 draft 목록을 볼 때 의도를 명시적으로 읽을 수
-- 있도록 컬럼을 추가하는 쪽을 택했다.
ALTER TABLE pages_draft ADD COLUMN action text NOT NULL DEFAULT 'write';

-- docs/spec.md §4.4/§4.7 — org KB는 "사전에 준비돼 있다고 가정"한다고 provisioning.ts에
-- 명시돼 있지만, 실제로 그걸 만드는 코드가 지금까지 없었다. §4.7의 "org 기본
-- protected 범위: 전체 경로(**), mode='block'"를 적용하려면 최소한 protected_patterns
-- 행이 필요하고, 그 KB 자체도 있어야 pages.kb_id FK가 성립하므로 여기서 함께 seed한다.
INSERT INTO knowledge_bases (id, type, parent_id)
VALUES ('org', 'org', NULL)
ON CONFLICT (id) DO NOTHING;

INSERT INTO pages (kb_id, slug, title, content_md)
VALUES ('org', '_index', '_index', ''), ('org', '_log', '_log', '')
ON CONFLICT (kb_id, slug) DO NOTHING;

INSERT INTO kb_versions (kb_id, version) VALUES ('org', 0)
ON CONFLICT (kb_id) DO NOTHING;

INSERT INTO protected_patterns (kb_id, pattern, mode) VALUES ('org', '**', 'block')
ON CONFLICT (kb_id, pattern) DO NOTHING;

-- Down Migration

DELETE FROM protected_patterns WHERE kb_id = 'org' AND pattern = '**';
DELETE FROM kb_versions WHERE kb_id = 'org';
DELETE FROM pages WHERE kb_id = 'org' AND slug IN ('_index', '_log');
DELETE FROM knowledge_bases WHERE id = 'org';
ALTER TABLE pages_draft DROP COLUMN action;
