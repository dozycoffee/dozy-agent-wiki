// kb_versions 워터마크 — docs/spec.md §3.3
//
// KB 전체 단위(페이지별 아님) 버전 카운터. 페이지가 변경될 때마다(write/append/delete/
// revert/commit_session) 소속 KB의 version을 1 증가시킨다. §4.6 세션 충돌 감지
// (pages.version)와는 별개 메커니즘 — 이건 "읽어둔 내용이 여전히 최신인가"만 저비용으로
// 판단하기 위한 용도다.

import type { Pool, PoolClient } from "pg";

/**
 * kb_id의 워터마크를 1 증가시킨다. 트랜잭션 내부에서 호출해 실제 페이지 변경과
 * 원자적으로 묶는다. kb_versions 행이 아직 없으면(예: org KB처럼 이 기능 도입 전에
 * 생성된 KB) 1로 새로 만든다 — UPSERT라 존재 여부를 미리 확인할 필요가 없다.
 */
export async function bumpKbVersion(client: PoolClient, kbId: string): Promise<void> {
  await client.query(
    `INSERT INTO kb_versions (kb_id, version) VALUES ($1, 1)
     ON CONFLICT (kb_id) DO UPDATE SET version = kb_versions.version + 1`,
    [kbId],
  );
}

/** kb_id의 현재 워터마크를 조회한다. 행이 없으면(아직 한 번도 변경된 적 없음) 0. */
export async function getKbVersion(pool: Pool, kbId: string): Promise<number> {
  const { rows } = await pool.query<{ version: string }>(
    `SELECT version FROM kb_versions WHERE kb_id = $1`,
    [kbId],
  );
  // bigint → pg가 string 반환하므로 number로 정규화 (write()의 기존 관례와 동일).
  return rows[0] ? Number(rows[0].version) : 0;
}

/** 여러 kb_id의 워터마크를 한 번에 조회한다 (search 응답용). */
export async function getKbVersions(pool: Pool, kbIds: string[]): Promise<Map<string, number>> {
  if (kbIds.length === 0) return new Map();
  const { rows } = await pool.query<{ kb_id: string; version: string }>(
    `SELECT kb_id, version FROM kb_versions WHERE kb_id = ANY($1)`,
    [kbIds],
  );
  const map = new Map<string, number>();
  for (const row of rows) {
    map.set(row.kb_id, Number(row.version));
  }
  return map;
}
