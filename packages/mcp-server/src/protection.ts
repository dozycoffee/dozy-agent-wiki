// 콘텐츠 보호(protected_patterns) — docs/spec.md §4.7
//
// GitHub CODEOWNERS와 같은 발상의 경로 패턴 매칭. commit.ts의 commitChanges()가
// 실제 반영 전에 이 모듈로 대상 slug들을 분류해 block/notify/none을 판단한다.

import type { Pool, PoolClient } from "pg";
import { parseKbId } from "./kbId.js";

export interface ProtectionMatch {
  slug: string;
  pattern: string;
  mode: string;
}

export interface ProtectionClassification {
  mode: "block" | "notify" | "none";
  matched: ProtectionMatch[];
}

function escapeRegExpChar(ch: string): string {
  return /[.*+?^${}()|[\]\\]/.test(ch) ? `\\${ch}` : ch;
}

/**
 * CODEOWNERS 스타일 glob → RegExp. `**`는 `/` 포함 임의 문자열, 단일 `*`는 `/`를
 * 제외한 임의 문자열에 매칭된다. 예: "conventions/**" → "conventions/coding-style"에
 * 매칭(단, "conventions" 자체에는 매칭 안 됨 — trailing `/**`는 하위 경로만 의미).
 * "**"는 모든 slug에 매칭(org 기본 정책).
 */
function patternToRegExp(pattern: string): RegExp {
  let src = "";
  for (let i = 0; i < pattern.length; i++) {
    if (pattern[i] === "*" && pattern[i + 1] === "*") {
      src += ".*";
      i++;
    } else if (pattern[i] === "*") {
      src += "[^/]*";
    } else {
      src += escapeRegExpChar(pattern[i]);
    }
  }
  return new RegExp(`^${src}$`);
}

export function matchesPattern(slug: string, pattern: string): boolean {
  return patternToRegExp(pattern).test(slug);
}

/**
 * touched slug들을 protected_patterns와 대조해 이 커밋이 block/notify/none 중
 * 어디에 해당하는지 판단한다.
 *
 * - personal KB는 §4.7 "보호 불가(patterns 등록 금지)"라 항상 "none".
 * - 하나라도 mode='block' 패턴에 매칭되면 전체가 "block" (§4.7 "protected/일반
 *   경로가 섞인 세션이면 전체를 draft로" — v1 단순화, block이 notify보다 우선).
 * - block은 없고 notify만 있으면 "notify" (즉시 반영 + 알림 로그).
 * - 아무 매칭도 없으면 "none" (즉시 반영, 평소와 동일).
 */
export async function classifyProtection(
  db: Pool | PoolClient,
  kbId: string,
  slugs: string[],
): Promise<ProtectionClassification> {
  const parsed = parseKbId(kbId);
  if (parsed?.type === "personal" || slugs.length === 0) {
    return { mode: "none", matched: [] };
  }

  const { rows } = await db.query<{ pattern: string; mode: string }>(
    `SELECT pattern, mode FROM protected_patterns WHERE kb_id = $1`,
    [kbId],
  );
  if (rows.length === 0) {
    return { mode: "none", matched: [] };
  }

  const matched: ProtectionMatch[] = [];
  for (const slug of slugs) {
    for (const p of rows) {
      if (matchesPattern(slug, p.pattern)) {
        matched.push({ slug, pattern: p.pattern, mode: p.mode });
      }
    }
  }

  if (matched.some((m) => m.mode === "block")) return { mode: "block", matched };
  if (matched.some((m) => m.mode === "notify")) return { mode: "notify", matched };
  return { mode: "none", matched };
}
