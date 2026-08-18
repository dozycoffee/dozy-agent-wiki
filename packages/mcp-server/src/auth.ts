// GitHub OAuth 토큰 검증 + 권한 판단 — docs/spec.md §4.3, §5
//
// §5.2 검증 흐름:
//   1. Authorization 헤더 → GitHub 토큰 검증 → github_user 확정
//   2. 요청 대상 kb_id 확인
//   3. kb.type별 권한 규칙 적용 (§5.1)
//   4. project KB의 경우 permission_cache 조회, 없으면 GitHub API 호출 후 짧은 TTL로 캐시
//   5. write/delete인 경우 protected_patterns 매칭 확인 → draft 경유 여부 결정
//      (이 파일의 authorize()가 아니라 commit.ts의 commitChanges()가 커밋 시점에
//      classifyProtection()으로 수행한다 — §4.7, protection.ts 참고)
//   6. 허용/거부 결정 → audit_log 기록 (audit.ts)

import type { Pool } from "pg";
import type { FastifyRequest } from "fastify";
import {
  type FetchLike,
  fetchCollaboratorPermission,
  fetchOrgMembership,
  permissionAtLeast,
  resolveGithubUser,
} from "./github.js";
import { getCachedPermission, setCachedPermission } from "./permissionCache.js";
import { parseKbId } from "./kbId.js";

// "delete"는 §5.1에서 KB 유형별 문턱이 write보다 높다 (org/project는 관리자만,
// personal은 write와 동일하게 본인만) — write와 분리된 별도 action으로 판단한다.
export type ToolAction = "read" | "write" | "delete";

export interface RequestContext {
  githubUser?: string;
  githubToken?: string;
  /** wiki-cli mcp가 보내는 정규화된 repo 식별자 ("host/owner/repo"). 참고/로깅용 —
   * 보안 판단(권한 검사)은 클라이언트가 매 tool 호출마다 명시하는 kb_id를 기준으로
   * 한다. 아래 "설계 판단" 참고. */
  xRepo?: string;
  pool: Pool;
  fetchImpl: FetchLike;
}

export interface AuthDecision {
  allowed: boolean;
  reason?: string;
}

function extractBearerToken(request: FastifyRequest): string | undefined {
  const raw = request.headers["authorization"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(value.trim());
  return match?.[1]?.trim() || undefined;
}

function extractXRepo(request: FastifyRequest): string | undefined {
  const raw = request.headers["x-repo"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value?.trim() || undefined;
}

/** Fastify request로부터 이번 요청의 identity/컨텍스트를 확정한다 (§5.2 1단계). */
export async function buildRequestContext(
  request: FastifyRequest,
  pool: Pool,
  fetchImpl: FetchLike = fetch,
): Promise<RequestContext> {
  const token = extractBearerToken(request);
  const githubUser = await resolveGithubUser(token, fetchImpl);
  return {
    githubUser,
    githubToken: token,
    xRepo: extractXRepo(request),
    pool,
    fetchImpl,
  };
}

function wikiAdmins(): Set<string> {
  const raw = process.env.WIKI_ADMINS ?? "";
  return new Set(
    raw
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
  );
}

async function isOrgReadAllowed(ctx: RequestContext, githubUser: string): Promise<boolean> {
  const org = process.env.GITHUB_ORG;
  if (!org) {
    // GITHUB_ORG가 설정 안 된 배포(로컬 개발 등)에서는 실제 조직 멤버십을 확인할 방법이
    // 없다 — spec/§6.2 docker-compose에도 org 식별자 설정이 없다. 이 경우 "인증된
    // 사용자는 org read 가능"으로 완화한다 (미인증은 어차피 앞단에서 걸러짐). 실서비스
    // 배포 시 GITHUB_ORG를 반드시 설정해야 §5.1의 "조직 멤버 전체" 규칙이 실제로 적용됨.
    return true;
  }

  const cacheKey = `org:${org}`;
  const cached = await getCachedPermission(ctx.pool, githubUser, cacheKey);
  if (cached !== undefined) return cached === "member";

  const isMember = ctx.githubToken
    ? await fetchOrgMembership(org, githubUser, ctx.githubToken, ctx.fetchImpl)
    : false;
  await setCachedPermission(ctx.pool, githubUser, cacheKey, isMember ? "member" : "none");
  return isMember;
}

/**
 * kb_id 하나에 대한 read/write/delete 권한을 판단한다 (§5.1 매핑 규칙).
 * protected_patterns/pages_draft 게이트(§4.7)는 이 함수의 범위 밖이다 — "이 유저가
 * 이 KB에 쓸 수 있는가"(권한)와 "이 경로가 즉시 반영돼도 되는가"(보호 정책)는
 * 별개 판단이라, 후자는 commit.ts의 commitChanges()가 커밋 시점에 처리한다.
 */
export async function authorize(
  ctx: RequestContext,
  kbId: string,
  action: ToolAction,
): Promise<AuthDecision> {
  if (!ctx.githubUser) {
    return { allowed: false, reason: "missing or invalid GitHub token" };
  }

  const parsed = parseKbId(kbId);
  if (!parsed) {
    return { allowed: false, reason: `malformed kb_id: ${kbId}` };
  }

  if (parsed.type === "org") {
    if (action === "read") {
      const allowed = await isOrgReadAllowed(ctx, ctx.githubUser);
      return allowed ? { allowed: true } : { allowed: false, reason: "not an org member" };
    }
    // org 쓰기/삭제: §5.1에서 둘 다 wiki-admins만 허용 (전체가 protected라 쓰기는
    // 실질적으로 draft 경유 — §4.7). 삭제도 같은 문턱이라 write/delete를 분기하지 않는다.
    const admins = wikiAdmins();
    if (admins.size === 0) {
      // WIKI_ADMINS 미설정 시 아무도 org에 쓸 수 없는 게 안전한 기본값이다.
      return { allowed: false, reason: "org write requires WIKI_ADMINS to be configured" };
    }
    return admins.has(ctx.githubUser)
      ? { allowed: true }
      : { allowed: false, reason: "org write requires wiki-admin" };
  }

  if (parsed.type === "personal") {
    // 본인만 read/write 가능 (§5.1) — GitHub API 호출/캐시 불필요.
    return ctx.githubUser === parsed.owner
      ? { allowed: true }
      : { allowed: false, reason: "personal KB is only accessible to its owner" };
  }

  // project: permission_cache 조회 → miss면 GitHub API (§5.2 4단계)
  const repoSlug = parsed.repoSlug!;
  let permission = await getCachedPermission(ctx.pool, ctx.githubUser, repoSlug);
  if (permission === undefined) {
    permission = ctx.githubToken
      ? await fetchCollaboratorPermission(repoSlug, ctx.githubUser, ctx.githubToken, ctx.fetchImpl)
      : "none";
    await setCachedPermission(ctx.pool, ctx.githubUser, repoSlug, permission);
  }

  // project 삭제: §5.1에서 repo **admin**만 허용 (write보다 높은 문턱).
  const threshold = action === "delete" ? "admin" : action;
  const allowed = permissionAtLeast(permission, threshold);
  return allowed
    ? { allowed: true }
    : { allowed: false, reason: `insufficient repo permission for ${repoSlug} (have: ${permission}, need: ${threshold})` };
}
