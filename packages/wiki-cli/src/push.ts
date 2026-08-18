// `wiki-cli push` 핵심 로직 — docs/spec.md §4.5.
//
// POST /api/kb/{kb_id}/pages 로 .md 파일을 multipart/form-data 업로드한다. `mcp`
// 서브커맨드(mcp-relay.ts)와 동일하게 WIKI_SERVER_URL env(기본 localhost:8080)를 서버
// base URL로 쓰고, OS 키체인(keychain.ts)의 GitHub 토큰을 Authorization 헤더로 붙인다.
//
// 여러 파일 업로드 (§4.5 "docs/*.md 여러 파일 일괄"):
// - 대부분의 유닉스 셸은 `wiki-cli push docs/*.md`를 실행 전에 이미 전개(expand)해서
//   이 프로세스는 전개된 파일 경로 배열을 그대로 받는다 (index.ts에서 commander의
//   `<files...>` variadic 인자로 선언).
// - 다만 glob을 전개하지 않는 셸/호출자(Windows cmd/PowerShell, 패턴을 따옴표로 감싸는
//   경우 등)를 위해 각 인자를 "리터럴 경로로 실제 존재하면 그대로 쓰고, 아니면 glob
//   패턴으로 간주해 전개한다"는 폴백을 둔다 — `glob` 패키지(npm 최다운로드 패키지 중
//   하나, isaacs 관리, Node 20/22 지원)를 사용한다.

import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { glob } from "glob";
import { loadToken } from "./keychain.js";

const DEFAULT_WIKI_SERVER_URL = "http://localhost:8080";

/** 서버가 인증/권한 문제로 요청을 거부했을 때 던진다 — 이후 파일들도 어차피 같은
 * 이유로 실패할 것이 확실하므로(같은 kb_id/token), 배치를 계속 시도하지 않고
 * 스택 트레이스 대신 사람이 읽을 수 있는 메시지로 즉시 중단한다. */
export class PushAuthError extends Error {}

export interface PushOptions {
  kbId: string;
  /** 테스트용: 파일 경로/glob을 어느 디렉토리 기준으로 풀지. 기본값은 process.cwd(). */
  cwd?: string;
  /** 테스트용: 실제 MCP 서버 base URL. 기본값은 WIKI_SERVER_URL env, 없으면 localhost:8080. */
  serverUrl?: string;
  /** 테스트용: 키체인 대신 직접 넘기는 GitHub 토큰. */
  token?: string;
}

export type PushResult =
  | { file: string; status: "applied"; slug: string; title: string; version: number }
  // §4.7: protected_patterns(mode='block')에 걸려 즉시 반영되지 않고 pages_draft에
  // pending으로 남은 경우. 서버는 이때 200이 아니라 202를 반환한다 — res.ok만 보고
  // 성공으로 취급하면 존재하지 않는 slug/title/version 필드를 읽게 되므로 별도 분기한다.
  | { file: string; status: "draft"; draftIds: string[] }
  | { file: string; status: "failed"; httpStatus?: number; error: string };

/** 인자(리터럴 경로 또는 glob 패턴) 배열을 실제 파일 경로 목록으로 전개한다. */
export async function resolveFiles(patterns: string[], cwd: string): Promise<string[]> {
  const resolved: string[] = [];
  for (const pattern of patterns) {
    const literalPath = path.resolve(cwd, pattern);
    const isLiteralFile = await stat(literalPath)
      .then((s) => s.isFile())
      .catch(() => false);

    if (isLiteralFile) {
      resolved.push(literalPath);
      continue;
    }

    const matches = await glob(pattern, { cwd, nodir: true, absolute: true });
    if (matches.length === 0) {
      throw new Error(`no files matched: ${pattern}`);
    }
    resolved.push(...matches);
  }
  return [...new Set(resolved)]; // 같은 파일이 여러 패턴에 매칭될 수 있어 중복 제거
}

/** 로컬 파일 경로에서 서버에 보낼 slug를 뽑아낸다: cwd 기준 상대경로, "/" 구분자로
 * 정규화, `.md` 확장자 제거. (§3.1: slug는 "/"로 구분된 경로처럼 가벼운 폴더 구조를 흉내낸다) */
export function deriveSlug(filePath: string, cwd: string): string {
  const rel = path.relative(cwd, filePath).split(path.sep).join("/");
  return rel.replace(/\.md$/i, "");
}

interface UploadContext {
  kbId: string;
  cwd: string;
  serverUrl: string;
  token: string;
}

async function pushOne(filePath: string, ctx: UploadContext): Promise<PushResult> {
  if (!/\.md$/i.test(filePath)) {
    return { file: filePath, status: "failed", error: "only .md files are supported" };
  }

  const slug = deriveSlug(filePath, ctx.cwd);
  const buffer = await readFile(filePath);

  const form = new FormData();
  form.set("slug", slug);
  form.set("file", new Blob([buffer], { type: "text/markdown" }), path.basename(filePath));

  const endpoint = new URL(`/api/kb/${encodeURIComponent(ctx.kbId)}/pages`, ctx.serverUrl);
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { Authorization: `Bearer ${ctx.token}` },
    body: form,
  });

  if (res.status === 401 || res.status === 403) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    throw new PushAuthError(body.error ?? `authorization failed (HTTP ${res.status})`);
  }

  // 202: protected_patterns(mode='block')에 걸려 승인 대기로 접수됨 (§4.7). res.ok
  // 범위(200-299) 안이라 아래 !res.ok 분기로는 안 걸린다 — 먼저 따로 처리해야 한다.
  if (res.status === 202) {
    const body = (await res.json()) as { draft_ids: string[] };
    return { file: filePath, status: "draft", draftIds: body.draft_ids };
  }

  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as { error?: string };
    return {
      file: filePath,
      status: "failed",
      httpStatus: res.status,
      error: body.error ?? `HTTP ${res.status}`,
    };
  }

  const body = (await res.json()) as { slug: string; title: string; version: number };
  return { file: filePath, status: "applied", slug: body.slug, title: body.title, version: body.version };
}

/**
 * `wiki-cli push`의 본 로직: 인자(경로/glob)를 실제 파일 목록으로 전개하고, 각 파일을
 * 순차적으로 POST /api/kb/{kb_id}/pages 로 업로드한다.
 * OS 키체인에 토큰이 없으면(로그인 안 함) PushAuthError를 던진다.
 */
export async function pushFiles(patterns: string[], options: PushOptions): Promise<PushResult[]> {
  const cwd = options.cwd ?? process.cwd();
  const serverUrl = options.serverUrl ?? process.env.WIKI_SERVER_URL ?? DEFAULT_WIKI_SERVER_URL;
  const token = options.token ?? loadToken();

  if (!token) {
    throw new PushAuthError(
      "OS 키체인에서 GitHub 토큰을 찾을 수 없습니다 — 먼저 `wiki-cli login`을 실행하세요.",
    );
  }

  const files = await resolveFiles(patterns, cwd);

  const results: PushResult[] = [];
  for (const file of files) {
    results.push(await pushOne(file, { kbId: options.kbId, cwd, serverUrl, token }));
  }
  return results;
}
