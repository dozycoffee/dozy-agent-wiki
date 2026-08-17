// KB 즉석 자동 생성 — docs/spec.md §4.4, §3.1
//
// project/personal KB가 없는 상태로 첫 요청이 오면, 요청 처리 전에 즉석 생성한다.
// personal KB는 parent인 project KB도 없으면 함께 생성한다. 새로 생성되는 KB는
// 예약 페이지 `_index`, `_log`를 빈 페이지로 함께 만든다 (§3.1).
//
// 이 함수는 authorize()가 이미 허용 판정을 내린 뒤에만 호출한다 — 권한 없는
// 사용자가 임의의 project/personal KB를 프로비저닝(생성)해버리는 것을 막기 위해서다
// (project는 GitHub read 권한, personal은 본인 소유일 때만 authorize()가 통과시킨다).

import type { Pool, PoolClient } from "pg";
import { parseKbId, type KbType } from "./kbId.js";

const UNIQUE_VIOLATION = "23505";

function isUniqueViolation(err: unknown): boolean {
  return typeof err === "object" && err !== null && (err as { code?: string }).code === UNIQUE_VIOLATION;
}

/**
 * kb_id가 없으면 (그리고 personal이면 parent project KB도 없으면) 생성한다.
 * 이미 존재하면 아무 것도 하지 않는다 (idempotent). org KB는 이 트리거 대상이 아니다
 * (§4.4 표에 org 자동 생성은 없음 — 사전에 준비돼 있다고 가정).
 */
export async function ensureKbProvisioned(pool: Pool, kbId: string): Promise<void> {
  const parsed = parseKbId(kbId);
  if (!parsed || parsed.type === "org") return;

  if (parsed.type === "personal") {
    // parent project KB 먼저 (없으면 생성), 그 다음 personal KB.
    await ensureKbRow(pool, parsed.repoSlug!, "project", null);
    await ensureKbRow(pool, kbId, "personal", parsed.repoSlug!);
    return;
  }

  await ensureKbRow(pool, kbId, "project", null);
}

async function ensureKbRow(
  pool: Pool,
  id: string,
  type: KbType,
  parentId: string | null,
): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const { rows } = await client.query<{ id: string }>(
      `SELECT id FROM knowledge_bases WHERE id = $1 FOR UPDATE`,
      [id],
    );

    if (rows.length === 0) {
      await client.query(
        `INSERT INTO knowledge_bases (id, type, parent_id) VALUES ($1, $2, $3)`,
        [id, type, parentId],
      );
      await insertReservedPage(client, id, "_index");
      await insertReservedPage(client, id, "_log");
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    // 동시에 두 요청이 같은 kb_id를 처음 프로비저닝하려 하면, SELECT ... FOR UPDATE는
    // (아직 존재하지 않는 행이라) 서로를 막지 못하고 두 번째 INSERT가
    // knowledge_bases.id PK 위반으로 실패한다. 이 경우 "누군가 먼저 만들었다"는
    // 뜻이므로 idempotent하게 무시한다 — 재시도 불필요, 결과적으로 정확히 1번 생성됨.
    if (!isUniqueViolation(err)) {
      throw err;
    }
  } finally {
    client.release();
  }
}

async function insertReservedPage(client: PoolClient, kbId: string, slug: "_index" | "_log"): Promise<void> {
  await client.query(
    `INSERT INTO pages (kb_id, slug, title, content_md) VALUES ($1, $2, $2, '')`,
    [kbId, slug],
  );
}
