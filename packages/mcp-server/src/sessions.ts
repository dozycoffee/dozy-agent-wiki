// 편집 세션(edit_sessions/session_changes) 헬퍼 — docs/spec.md §4.6
//
// open_session → stage_write/stage_append/stage_delete(여러 번) → commit_session
// 흐름의 세션 상태 조회/검증을 담당한다. 실제 커밋 로직(FOR UPDATE 잠금, 충돌 검증,
// protected_patterns 게이트)은 commit.ts의 commitChanges()를 그대로 재사용한다.

import type { Pool } from "pg";
import type { ChangeAction, PendingChange } from "./commit.js";

export interface SessionRow {
  id: string;
  kb_id: string;
  opened_by: string;
  status: string;
  expires_at: string;
}

/**
 * 세션을 조회하고, open 상태인데 이미 만료됐으면 그 자리에서 status='expired'로
 * 갱신한다(§4.6: "방치돼도 다른 사람 작업을 막지 않는다" — 별도 정리 배치 없이
 * 다음 접근 시점에 지연 반영하는 방식을 택함, §9 미해결 이슈의 "정리 배치 주기"는
 * 이 지연 반영으로 충분하다고 판단해 별도 배치는 만들지 않았다).
 */
export async function getSession(pool: Pool, sessionId: string): Promise<SessionRow | undefined> {
  const { rows } = await pool.query<SessionRow>(
    `SELECT id, kb_id, opened_by, status, expires_at FROM edit_sessions WHERE id = $1`,
    [sessionId],
  );
  const row = rows[0];
  if (!row) return undefined;

  if (row.status === "open" && new Date(row.expires_at).getTime() < Date.now()) {
    await pool.query(`UPDATE edit_sessions SET status = 'expired' WHERE id = $1`, [sessionId]);
    row.status = "expired";
  }

  return row;
}

export async function insertSessionChange(
  pool: Pool,
  sessionId: string,
  slug: string,
  action: ChangeAction,
  contentMd: string | undefined,
  expectedVersion: number,
): Promise<void> {
  await pool.query(
    `INSERT INTO session_changes (session_id, slug, action, content_md, expected_version)
     VALUES ($1, $2, $3, $4, $5)`,
    [sessionId, slug, action, contentMd ?? null, expectedVersion],
  );
}

export async function getSessionChanges(pool: Pool, sessionId: string): Promise<PendingChange[]> {
  const { rows } = await pool.query<{
    slug: string;
    action: ChangeAction;
    content_md: string | null;
    expected_version: string;
  }>(
    `SELECT slug, action, content_md, expected_version
     FROM session_changes WHERE session_id = $1 ORDER BY id`,
    [sessionId],
  );
  return rows.map((r) => ({
    slug: r.slug,
    action: r.action,
    content: r.content_md ?? undefined,
    expectedVersion: Number(r.expected_version),
  }));
}

/** 세션에 쌓인 변경들이 요구하는 권한 action 집합 ('write'는 항상, delete가 하나라도 있으면 추가). */
export function requiredActionsFor(changes: PendingChange[]): Array<"write" | "delete"> {
  const actions = new Set<"write" | "delete">(["write"]);
  if (changes.some((c) => c.action === "delete")) actions.add("delete");
  return [...actions];
}
