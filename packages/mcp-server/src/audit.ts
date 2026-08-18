// audit_log 기록 — docs/spec.md §3.2, §5.2 6단계 ("허용/거부 결정 → audit_log 기록")
//
// 스키마의 action 컬럼은 CHECK 제약이 없는 자유 text이고 주석엔 예시값
// (read|write|delete|admin_override)만 있다. 거부(deny) 여부를 구분할 별도 컬럼이
// 없으므로, 이 구현에서는 action에 "_denied" 접미사를 붙여 허용/거부를 함께
// 기록한다 (예: "read", "read_denied"). PR에 명시적으로 남길 판단.
//
// action은 자유 text 컬럼이라 tool 이름을 그대로 기록해도 무방하다 (2차 구현에서
// tool 개수가 늘어나 고정 union을 유지하는 비용이 늘어나므로 string으로 완화).

import type { Pool } from "pg";

export type AuditAction = string;

export async function recordAudit(
  pool: Pool,
  githubUser: string | undefined,
  kbId: string | null,
  action: AuditAction,
  allowed: boolean,
): Promise<void> {
  const actionValue = allowed ? action : `${action}_denied`;
  await pool.query(
    `INSERT INTO audit_log (github_user, kb_id, action) VALUES ($1, $2, $3)`,
    [githubUser ?? null, kbId, actionValue],
  );
}
