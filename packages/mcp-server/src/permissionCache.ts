// permission_cache 테이블 read/write — docs/spec.md §3.2, §5.2 4단계
//
// project KB(및 org 멤버십 조회 결과, repo_slug = "org:<org>"로 네임스페이스 구분)
// 권한을 짧은 TTL로 캐시해 매 tool 호출마다 GitHub API를 때리지 않게 한다.

import type { Pool } from "pg";

// "짧은 TTL" — repo에서 collaborator가 제거돼도 이 시간 내에는 자동 반영된다 (§5.3).
export const PERMISSION_CACHE_TTL_SECONDS = 300;

export async function getCachedPermission(
  pool: Pool,
  githubUser: string,
  repoSlug: string,
): Promise<string | undefined> {
  const { rows } = await pool.query<{ permission: string }>(
    `SELECT permission FROM permission_cache
     WHERE github_user = $1 AND repo_slug = $2 AND expires_at > now()`,
    [githubUser, repoSlug],
  );
  return rows[0]?.permission;
}

export async function setCachedPermission(
  pool: Pool,
  githubUser: string,
  repoSlug: string,
  permission: string,
  ttlSeconds: number = PERMISSION_CACHE_TTL_SECONDS,
): Promise<void> {
  await pool.query(
    `INSERT INTO permission_cache (github_user, repo_slug, permission, expires_at)
     VALUES ($1, $2, $3, now() + make_interval(secs => $4))
     ON CONFLICT (github_user, repo_slug)
     DO UPDATE SET permission = $3, expires_at = now() + make_interval(secs => $4)`,
    [githubUser, repoSlug, permission, ttlSeconds],
  );
}
