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

// §4.7 mode='notify' — 즉시 반영은 하되 승인권자에게 diff를 알려야 한다. 알림 채널
// (Slack/이메일 등)은 §9 미해결 이슈라 아직 없으므로, "일단 로그/DB 기록까지만 해도
// 됨"이라는 이슈 본문 지침대로 audit_log에 매칭된 slug/pattern을 기록하는 선에서
// 그친다. action 컬럼이 자유 text라 별도 테이블 없이 여기 슬러그 목록을 그대로 담는다.
export async function recordProtectedNotify(
  pool: Pool,
  githubUser: string | undefined,
  kbId: string,
  matched: Array<{ slug: string; pattern: string }>,
): Promise<void> {
  const detail = matched.map((m) => `${m.slug}~${m.pattern}`).join(",");
  await pool.query(
    `INSERT INTO audit_log (github_user, kb_id, action) VALUES ($1, $2, $3)`,
    [githubUser ?? null, kbId, `protected_notify:${detail}`],
  );
}
