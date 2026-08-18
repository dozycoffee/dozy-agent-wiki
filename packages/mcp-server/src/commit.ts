// 공용 커밋 엔진 — docs/spec.md §4.6
//
// write/append/delete shorthand와 commit_session이 모두 이 함수 하나를 거친다
// (판단 근거는 PR 설명 참고: "건드린 slug만 FOR UPDATE + 알파벳순 잠금"이라는 핵심
// 로직과 향후 §4.7 protected_patterns 게이트를 두 경로에 각각 구현해 어긋나게 두는
// 것보다, 공용 함수 하나로 통일하는 쪽이 안전하다고 판단했다).
//
// 세션에서 같은 slug를 여러 번 stage한 경우(예: stage_write 후 stage_append)도
// 지원한다 — expected_version은 그 slug에 대한 "첫 번째" staged change 기준으로만
// 검증하고(클라이언트가 최초에 읽었던 버전), 이후 같은 slug에 대한 추가 변경들은
// 순서대로 내용에 접어(fold) 최종 상태를 계산한다. 커밋 시 버전은 slug당 정확히
// 1만큼만 증가한다(spec pseudocode의 "각 페이지 version += 1"과 일치).

import type { Pool } from "pg";
import { parseKbId } from "./kbId.js";
import { bumpKbVersion } from "./kbVersions.js";
import { deriveTitle, appendContent } from "./pageUtils.js";

export type ChangeAction = "write" | "append" | "delete";

export interface PendingChange {
  slug: string;
  action: ChangeAction;
  content?: string;
  expectedVersion: number;
  /** pages_history.action에 기록할 라벨. 생략하면 action을 그대로 쓴다 (revert 등에서 override). */
  historyLabel?: string;
}

export interface AppliedResult {
  slug: string;
  version: number;
  action: ChangeAction;
  title?: string;
}

export interface ConflictInfo {
  slug: string;
  expected: number;
  current: number;
}

export type CommitResult =
  | { status: "committed"; results: AppliedResult[] }
  | { status: "conflict"; conflicts: ConflictInfo[] };

interface FoldResult {
  deleted: boolean;
  content: string;
  lastAction: ChangeAction;
  historyLabel: string;
}

function foldOps(initialContent: string, ops: PendingChange[]): FoldResult {
  let content = initialContent;
  let deleted = false;
  let lastAction: ChangeAction = ops[0].action;
  let historyLabel = ops[0].historyLabel ?? ops[0].action;

  for (const op of ops) {
    lastAction = op.action;
    historyLabel = op.historyLabel ?? op.action;
    if (op.action === "delete") {
      deleted = true;
      content = "";
    } else if (op.action === "write") {
      deleted = false;
      content = op.content ?? "";
    } else {
      // append
      deleted = false;
      content = appendContent(content, op.content ?? "");
    }
  }

  return { deleted, content, lastAction, historyLabel };
}

function reduceBySlug(changes: PendingChange[]): Map<string, { expectedVersion: number; ops: PendingChange[] }> {
  const bySlug = new Map<string, { expectedVersion: number; ops: PendingChange[] }>();
  for (const c of changes) {
    const entry = bySlug.get(c.slug);
    if (entry) {
      entry.ops.push(c);
    } else {
      bySlug.set(c.slug, { expectedVersion: c.expectedVersion, ops: [c] });
    }
  }
  return bySlug;
}

/**
 * 여러 페이지 변경을 하나의 트랜잭션으로 원자적 커밋한다 (§4.6 pseudocode 구현체).
 * touched slug만 알파벳순으로 FOR UPDATE 잠근 뒤 current !== expected 비교식 하나로
 * 신규/수정/삭제를 모두 처리한다 (데드락 방지 + false positive 충돌 방지).
 *
 * personal KB는 즉시 하드 삭제, org/project는 soft-delete(deleted_at)로 처리한다 (§5.1).
 */
export async function commitChanges(
  pool: Pool,
  kbId: string,
  githubUser: string | undefined,
  changes: PendingChange[],
): Promise<CommitResult> {
  if (changes.length === 0) {
    return { status: "committed", results: [] };
  }

  const kbType = parseKbId(kbId)?.type;
  const bySlug = reduceBySlug(changes);
  const touchedSlugs = [...bySlug.keys()].sort();

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const conflicts: ConflictInfo[] = [];
    const rowState = new Map<string, { current: number; contentMd: string | null }>();

    for (const slug of touchedSlugs) {
      const { rows } = await client.query<{ version: string; content_md: string }>(
        `SELECT version, content_md FROM pages WHERE kb_id = $1 AND slug = $2 AND deleted_at IS NULL FOR UPDATE`,
        [kbId, slug],
      );
      const row = rows[0];
      const current = row ? Number(row.version) : 0;
      const expected = bySlug.get(slug)!.expectedVersion;
      if (current !== expected) {
        conflicts.push({ slug, expected, current });
      }
      rowState.set(slug, { current, contentMd: row ? row.content_md : null });
    }

    if (conflicts.length > 0) {
      await client.query("ROLLBACK");
      return { status: "conflict", conflicts };
    }

    const results: AppliedResult[] = [];

    for (const slug of touchedSlugs) {
      const { ops } = bySlug.get(slug)!;
      const state = rowState.get(slug)!;
      const folded = foldOps(state.contentMd ?? "", ops);

      if (state.contentMd !== null) {
        // 기존 페이지가 있었으면 변경 직전 상태를 history에 기록 (§3.2, §4.6)
        await client.query(
          `INSERT INTO pages_history (kb_id, slug, content_md, action, changed_by) VALUES ($1, $2, $3, $4, $5)`,
          [kbId, slug, state.contentMd, folded.historyLabel, githubUser ?? null],
        );
      }

      if (folded.deleted) {
        if (state.contentMd !== null) {
          if (kbType === "personal") {
            // personal: 본인, 즉시 삭제 (§5.1)
            await client.query(`DELETE FROM pages WHERE kb_id = $1 AND slug = $2`, [kbId, slug]);
          } else {
            // org/project: soft-delete (§5.1)
            await client.query(
              `UPDATE pages SET deleted_at = now(), updated_by = $3 WHERE kb_id = $1 AND slug = $2`,
              [kbId, slug, githubUser ?? null],
            );
          }
        }
        results.push({ slug, version: state.current, action: "delete" });
        continue;
      }

      const title = deriveTitle(slug, folded.content);

      if (state.contentMd !== null) {
        await client.query(
          `UPDATE pages SET content_md = $3, title = $4, updated_by = $5, version = version + 1,
                  updated_at = now(), deleted_at = NULL
           WHERE kb_id = $1 AND slug = $2`,
          [kbId, slug, folded.content, title, githubUser ?? null],
        );
        results.push({ slug, version: state.current + 1, action: folded.lastAction, title });
      } else {
        await client.query(
          `INSERT INTO pages (kb_id, slug, title, content_md, updated_by) VALUES ($1, $2, $3, $4, $5)`,
          [kbId, slug, title, folded.content, githubUser ?? null],
        );
        results.push({ slug, version: 1, action: folded.lastAction, title });
      }
    }

    // §3.3: 커밋된 변경이 하나라도 있으면 소속 KB 워터마크를 1 증가.
    await bumpKbVersion(client, kbId);

    await client.query("COMMIT");

    return { status: "committed", results };
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}
