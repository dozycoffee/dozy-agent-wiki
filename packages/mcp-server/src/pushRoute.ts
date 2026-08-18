// POST /api/kb/{kb_id}/pages — 사람이 md 파일을 직접 업로드하는 경로 (§4.5)
//
// MCP `write` tool(tools.ts)이 쓰는 것과 동일한 공용 커밋 엔진(commit.ts의
// commitChanges())을 재사용한다 — DB에 직접 접근하지 않는다. 인증도 /mcp 엔드포인트와
// 동일하게 buildRequestContext()/authorize()를 그대로 쓴다 (§4.3, §5.2).
//
// commitChanges()를 공유하는 덕분에 §4.7 protected_patterns 게이트와 §3.3 kb_versions
// 워터마크도 이 경로에 자동으로 적용된다 — 별도 구현 불필요.
//
// expected_version: 이 경로는 사람이 로컬 파일을 그냥 올리는 것이라 "이전에 read()로
// 실제로 본 버전"이라는 개념이 없다. 그래서 요청 시점의 현재 버전을 직접 조회해
// expectedVersion으로 넘긴다 — 사실상 "지금 상태 기준으로 덮어쓰기"다. 조회와
// commitChanges()의 FOR UPDATE 사이에 다른 쓰기가 끼어들면 conflict가 나는데, 그 경우
// 최신 버전으로 한 번 더 시도한다(최대 3회) — 매번 실패하면 진짜 동시 편집 경합으로 보고
// 409를 반환한다.

import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { authorize, buildRequestContext } from "./auth.js";
import { recordAudit } from "./audit.js";
import { ensureKbProvisioned } from "./provisioning.js";
import { commitChanges, type CommitResult } from "./commit.js";

// md 텍스트 파일 업로드 한도로 충분히 넉넉한 값. 이 이상은 잘못된 파일을 올린 것으로 본다.
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;
const MAX_WRITE_ATTEMPTS = 3;

/**
 * 업로드된 파일명에서 slug를 뽑아낸다 (마지막 수단 — 가능하면 `slug` 필드를 명시적으로
 * 보내는 쪽을 우선한다. multipart의 filename은 클라이언트가 임의로 지정하는 값이라
 * 디렉토리 구조가 보존된다는 보장이 없다).
 */
function deriveSlugFromFilename(filename: string): string {
  const normalized = filename.replace(/\\/g, "/").replace(/^\.?\/+/, "");
  return normalized.replace(/\.md$/i, "");
}

async function currentVersion(pool: Pool, kbId: string, slug: string): Promise<number> {
  const { rows } = await pool.query<{ version: string }>(
    `SELECT version FROM pages WHERE kb_id = $1 AND slug = $2 AND deleted_at IS NULL`,
    [kbId, slug],
  );
  return rows[0] ? Number(rows[0].version) : 0;
}

/** 현재 버전 기준으로 commitChanges()를 시도하고, 그 사이 다른 쓰기가 끼어들어
 * conflict가 나면 최신 버전으로 재시도한다 (최대 MAX_WRITE_ATTEMPTS회). */
async function writeWithRetry(
  pool: Pool,
  kbId: string,
  slug: string,
  content: string,
  githubUser: string | undefined,
): Promise<CommitResult> {
  let result: CommitResult;
  for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
    const expectedVersion = await currentVersion(pool, kbId, slug);
    result = await commitChanges(pool, kbId, githubUser, [
      { slug, action: "write", content, expectedVersion },
    ]);
    if (result.status !== "conflict") return result;
  }
  return result!;
}

export function registerPushRoute(app: FastifyInstance, pool: Pool): void {
  app.post<{ Params: { kb_id: string } }>("/api/kb/:kb_id/pages", async (request, reply) => {
    const ctx = await buildRequestContext(request, pool);
    const kbId = request.params.kb_id;

    if (!ctx.githubUser) {
      await recordAudit(pool, ctx.githubUser, kbId, "write", false);
      return reply.code(401).send({ error: "missing or invalid GitHub token" });
    }

    const decision = await authorize(ctx, kbId, "write");
    await recordAudit(pool, ctx.githubUser, kbId, "write", decision.allowed);
    if (!decision.allowed) {
      return reply.code(403).send({ error: decision.reason });
    }

    if (!request.isMultipart()) {
      return reply.code(400).send({ error: "expected multipart/form-data with a 'file' field" });
    }

    let data;
    try {
      data = await request.file({ limits: { fileSize: MAX_UPLOAD_BYTES } });
    } catch {
      return reply.code(413).send({ error: `file exceeds ${MAX_UPLOAD_BYTES} byte limit` });
    }
    if (!data) {
      return reply.code(400).send({ error: "missing 'file' field" });
    }

    let buffer: Buffer;
    try {
      buffer = await data.toBuffer();
    } catch {
      return reply.code(413).send({ error: `file exceeds ${MAX_UPLOAD_BYTES} byte limit` });
    }

    // slug 필드는 `data.toBuffer()`로 파일 스트림을 완전히 소비한 뒤에야 확실히 채워진다
    // (busboy가 파트를 순서대로 스트리밍하므로 — README 참고).
    const slugField = data.fields.slug;
    const explicitSlug =
      slugField && !Array.isArray(slugField) && slugField.type === "field"
        ? String(slugField.value)
        : undefined;
    const slug = explicitSlug?.trim() || deriveSlugFromFilename(data.filename);

    if (!slug) {
      return reply.code(400).send({ error: "could not determine slug from filename or 'slug' field" });
    }

    // write류 tool/route는 대상 kb_id를 명확히 겨냥하므로(§4.4) 여기서 KB 즉석
    // 프로비저닝을 트리거한다 — write tool(tools.ts)과 동일한 패턴.
    await ensureKbProvisioned(pool, kbId);

    const content = buffer.toString("utf8");
    const result = await writeWithRetry(pool, kbId, slug, content, ctx.githubUser);

    if (result.status === "conflict") {
      const [first] = result.conflicts;
      return reply.code(409).send({
        error: "concurrent write detected, please retry",
        expected: first.expected,
        current: first.current,
      });
    }

    if (result.status === "draft") {
      // §4.7: protected_patterns(mode='block')에 걸려 즉시 반영되지 않고 승인 대기.
      return reply.code(202).send({
        status: "draft",
        kb_id: kbId,
        draft_ids: result.draftIds,
        matched: result.matched,
      });
    }

    const [applied] = result.results;
    return reply.code(200).send({
      kb_id: kbId,
      slug: applied.slug,
      title: applied.title,
      version: applied.version,
    });
  });
}
