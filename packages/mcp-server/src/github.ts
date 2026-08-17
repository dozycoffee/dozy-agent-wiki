// GitHub API 연동 — docs/spec.md §4.3, §5.2
//
// 실제 네트워크 호출은 이 파일에만 격리한다. 테스트에서는 `fetchImpl`을 목(mock)으로
// 갈아끼워 실제 GitHub API를 호출하지 않고도 상위 로직(auth.ts)을 검증할 수 있다.

import { createHash } from "node:crypto";

export type FetchLike = typeof fetch;

const GITHUB_API_BASE = process.env.GITHUB_API_BASE ?? "https://api.github.com";

function githubHeaders(token: string): HeadersInit {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "User-Agent": "dozy-agent-wiki",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

/**
 * `GET /user`로 토큰을 검증하고 github_user(login)를 반환한다.
 * 토큰이 없거나, 만료/폐기됐거나, 네트워크 오류가 나면 undefined (= 거부 대상).
 */
export async function verifyGithubToken(
  token: string,
  fetchImpl: FetchLike = fetch,
): Promise<string | undefined> {
  try {
    const res = await fetchImpl(`${GITHUB_API_BASE}/user`, { headers: githubHeaders(token) });
    if (!res.ok) return undefined;
    const body = (await res.json()) as { login?: string };
    return body.login || undefined;
  } catch {
    return undefined;
  }
}

/**
 * `GET /repos/{owner}/{repo}/collaborators/{username}/permission`로 project KB
 * 권한(§5.1)을 조회한다. collaborator가 아니거나 조회 실패 시 "none".
 */
export async function fetchCollaboratorPermission(
  repoSlug: string,
  username: string,
  token: string,
  fetchImpl: FetchLike = fetch,
): Promise<string> {
  try {
    const res = await fetchImpl(
      `${GITHUB_API_BASE}/repos/${repoSlug}/collaborators/${encodeURIComponent(username)}/permission`,
      { headers: githubHeaders(token) },
    );
    if (!res.ok) return "none";
    const body = (await res.json()) as { permission?: string };
    return body.permission ?? "none";
  } catch {
    return "none";
  }
}

/**
 * `GET /orgs/{org}/members/{username}` — org KB 읽기 권한(§5.1, "조직 멤버 전체") 판단용.
 * 204면 멤버, 그 외(302/404 등)는 비멤버로 취급.
 */
export async function fetchOrgMembership(
  org: string,
  username: string,
  token: string,
  fetchImpl: FetchLike = fetch,
): Promise<boolean> {
  try {
    const res = await fetchImpl(
      `${GITHUB_API_BASE}/orgs/${encodeURIComponent(org)}/members/${encodeURIComponent(username)}`,
      { headers: githubHeaders(token), redirect: "manual" },
    );
    return res.status === 204;
  } catch {
    return false;
  }
}

const PERMISSION_RANK: Record<string, number> = {
  none: 0,
  read: 1,
  triage: 2,
  write: 3,
  maintain: 4,
  admin: 5,
};

export function permissionAtLeast(permission: string, threshold: "read" | "write"): boolean {
  const rank = PERMISSION_RANK[permission] ?? 0;
  const minRank = PERMISSION_RANK[threshold];
  return rank >= minRank;
}

// --- 토큰 검증 결과의 짧은 TTL 인메모리 캐시 (§4.3: "결과는 짧은 TTL로 캐시") ---
//
// permission_cache 테이블은 (github_user, repo_slug) 단위 권한 캐시 전용이라 토큰
// 자체의 유효성 캐시와는 성격이 다르다. 이 서버는 단일 인스턴스(§6.1)로만 배포되므로
// 프로세스 내 인메모리 캐시로 충분하다 — 별도 테이블을 새로 만들지 않는다.
const TOKEN_VERIFY_TTL_MS = 60_000;
const tokenCache = new Map<string, { login: string; expiresAt: number }>();

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** 토큰 검증 결과를 캐시하며 github_user를 반환한다. 실패 시 undefined. */
export async function resolveGithubUser(
  token: string | undefined,
  fetchImpl: FetchLike = fetch,
): Promise<string | undefined> {
  if (!token) return undefined;

  const key = hashToken(token);
  const cached = tokenCache.get(key);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.login;
  }

  const login = await verifyGithubToken(token, fetchImpl);
  if (!login) {
    tokenCache.delete(key);
    return undefined;
  }

  tokenCache.set(key, { login, expiresAt: Date.now() + TOKEN_VERIFY_TTL_MS });
  return login;
}

/** 테스트 전용: 토큰 검증 인메모리 캐시를 비운다. */
export function __clearTokenCacheForTests(): void {
  tokenCache.clear();
}
