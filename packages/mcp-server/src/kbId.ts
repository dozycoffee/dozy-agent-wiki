// kb_id 파싱 헬퍼 — docs/spec.md §2.1
//
//   org KB      : "org"
//   project KB  : "<owner>/<repo>"
//   personal KB : "<owner>/<repo>:<github_user>"

export type KbType = "org" | "project" | "personal";

export interface ParsedKbId {
  type: KbType;
  /** project/personal에서 소속 repo 식별자 ("<owner>/<repo>"). org면 undefined. */
  repoSlug?: string;
  /** personal KB의 소유자 github_user. personal이 아니면 undefined. */
  owner?: string;
}

const REPO_SLUG_RE = /^[^/\s:]+\/[^/\s:]+$/;

/**
 * kb_id 문자열을 타입별로 분해한다. 형식이 잘못됐으면 undefined를 반환한다
 * (예: "/", "owner/repo/extra", "owner/repo:" 등) — 호출자는 이를 "존재할 수 없는
 * kb_id"로 취급해 권한 거부해야 한다.
 */
export function parseKbId(kbId: string): ParsedKbId | undefined {
  if (kbId === "org") {
    return { type: "org" };
  }

  const colonIdx = kbId.indexOf(":");
  if (colonIdx >= 0) {
    const repoSlug = kbId.slice(0, colonIdx);
    const owner = kbId.slice(colonIdx + 1);
    if (!REPO_SLUG_RE.test(repoSlug) || owner.length === 0 || owner.includes(":")) {
      return undefined;
    }
    return { type: "personal", repoSlug, owner };
  }

  if (!REPO_SLUG_RE.test(kbId)) {
    return undefined;
  }
  return { type: "project", repoSlug: kbId };
}

/** personal KB id를 조립한다 ("<owner>/<repo>:<github_user>"). */
export function personalKbId(repoSlug: string, githubUser: string): string {
  return `${repoSlug}:${githubUser}`;
}
