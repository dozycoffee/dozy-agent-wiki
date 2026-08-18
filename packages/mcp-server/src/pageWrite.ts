// 단일 페이지 전체 교체(upsert) 핵심 로직 — docs/spec.md §4.6.
//
// MCP `write` tool(tools.ts)과 사람이 직접 업로드하는 POST /api/kb/{kb_id}/pages(§4.5,
// pushRoute.ts)가 이 함수를 공유한다. spec §4.5가 "DB에 직접 접근할 필요는 없다 —
// write가 쓰는 동일한 내부 함수를 재사용"이라고 명시하고 있어, upsert/버전 비교/
// pages_history 기록 로직을 여기 한 곳에만 둔다.
//
// 인증(authorize)과 audit_log 기록은 호출부(각 tool/route) 책임이다 — 이 함수는
// "이미 쓰기 권한이 확인된 요청"만 받는다고 가정한다 (write tool과 동일한 전제,
// provisioning.ts의 ensureKbProvisioned와 같은 패턴).

import type { Pool } from "pg";
import { ensureKbProvisioned } from "./provisioning.js";

// write()는 spec §4.1 시그니처에 title 인자가 없지만 pages.title은 NOT NULL이라,
// 콘텐츠의 첫 markdown 헤딩(# ...)을 제목으로 쓰고 없으면 slug 마지막 세그먼트로 대체한다.
export function deriveTitle(slug: string, content: string): string {
  const heading = content.match(/^#\s+(.+)$/m);
  if (heading) return heading[1].trim();
  const lastSegment = slug.split("/").pop();
  return lastSegment ?? slug;
}

export type WriteResult =
  | { conflict: false; kbId: string; slug: string; title: string; version: number }
  | { conflict: true; expected: number; current: number };

export interface WritePageOptions {
  /**
   * 낙관적 잠금 비교값 (§4.6, HTTP ETag/If-Match와 같은 발상). 클라이언트가 이전
   * read()로 실제 받았던 pages.version이어야 한다.
   *
   * undefined면 비교를 생략하고 무조건 덮어쓴다 — POST /api/kb/{kb_id}/pages(§4.5)처럼
   * 사전 read() 없이 사람이 파일을 직접 올리는 경로가 여기 해당한다. 그 경로는 애초에
   * "내가 마지막으로 본 버전"이라는 개념 자체가 없으므로 (git push --force와 비슷하게)
   * 파일 내용을 그대로 반영하는 것이 의도된 동작이다. 버전 충돌까지 다루고 싶으면
   * 세션 기반 흐름(open_session/stage_write/commit_session, §4.6)을 쓰면 된다.
   */
  expectedVersion?: number;
  updatedBy?: string;
}

/**
 * 단일 페이지 전체 교체(upsert). KB가 없으면 즉석 프로비저닝(§4.4)까지 포함한다.
 * 호출 전 authorize()/recordAudit()는 각 호출부 책임이다 (§5.2).
 */
export async function writePage(
  pool: Pool,
  kbId: string,
  slug: string,
  content: string,
  options: WritePageOptions = {},
): Promise<WriteResult> {
  // write류 tool/route는 대상 kb_id를 명확히 겨냥하므로(§4.4) 여기서 KB 즉석
  // 프로비저닝을 트리거한다 — 호출부가 이미 authorize()를 통과시켰다는 전제.
  await ensureKbProvisioned(pool, kbId);

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows } = await client.query(
      `SELECT version, content_md FROM pages WHERE kb_id = $1 AND slug = $2 FOR UPDATE`,
      [kbId, slug],
    );
    const existing = rows[0] as { version: string; content_md: string } | undefined;
    // pages.version은 bigint → pg가 string으로 반환한다. expected_version(number)과
    // 문자열 대 숫자로 비교하면 항상 불일치("1" !== 1) 판정되므로 Number로 정규화한다.
    const current = existing ? Number(existing.version) : 0;

    if (options.expectedVersion !== undefined && current !== options.expectedVersion) {
      await client.query("ROLLBACK");
      return { conflict: true, expected: options.expectedVersion, current };
    }

    const title = deriveTitle(slug, content);

    if (existing) {
      await client.query(
        `INSERT INTO pages_history (kb_id, slug, content_md, action) VALUES ($1, $2, $3, 'write')`,
        [kbId, slug, existing.content_md],
      );
      await client.query(
        `UPDATE pages SET content_md = $3, title = $4, updated_by = $5, version = version + 1, updated_at = now()
         WHERE kb_id = $1 AND slug = $2`,
        [kbId, slug, content, title, options.updatedBy ?? null],
      );
    } else {
      await client.query(
        `INSERT INTO pages (kb_id, slug, title, content_md, updated_by) VALUES ($1, $2, $3, $4, $5)`,
        [kbId, slug, title, content, options.updatedBy ?? null],
      );
    }

    await client.query("COMMIT");

    return { conflict: false, kbId, slug, title, version: current + 1 };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
