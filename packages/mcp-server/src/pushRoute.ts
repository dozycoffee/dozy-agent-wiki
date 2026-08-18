// POST /api/kb/{kb_id}/pages — 사람이 md 파일을 직접 업로드하는 경로 (§4.5)
//
// MCP `write` tool(tools.ts)이 쓰는 것과 동일한 내부 함수(pageWrite.ts의 writePage)를
// 재사용한다 — DB에 직접 접근하지 않는다. 인증도 /mcp 엔드포인트와 동일하게
// buildRequestContext()/authorize()를 그대로 쓴다 (§4.3, §5.2).
//
// 알려진 갭 (§4.7): protected_patterns 매칭 게이트는 아직 writePage()/write tool
// 어느 쪽에도 구현돼 있지 않다 — 별도 이슈(#19)에서 진행 중. 이 라우트는 write tool과
// 완전히 같은 writePage()를 호출하므로, #19가 writePage()(또는 그 상위 커밋 경로)에
// 게이트를 추가하는 순간 이 경로도 자동으로 같은 보호를 받는다. 그 전까지는 이 경로도
// write tool과 마찬가지로 protected_patterns 없이 즉시 반영된다.
//
// expected_version: 이 경로는 사람이 로컬 파일을 그냥 올리는 것이라 "이전에 read()로
// 실제로 본 버전"이라는 개념이 없다. 그래서 writePage()에 expectedVersion을 넘기지
// 않는다 — 즉 낙관적 잠금 비교 없이 항상 덮어쓴다(force). pageWrite.ts의 주석 참고.

import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import { authorize, buildRequestContext } from "./auth.js";
import { recordAudit } from "./audit.js";
import { writePage } from "./pageWrite.js";

// md 텍스트 파일 업로드 한도로 충분히 넉넉한 값. 이 이상은 잘못된 파일을 올린 것으로 본다.
const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

/**
 * 업로드된 파일명에서 slug를 뽑아낸다 (마지막 수단 — 가능하면 `slug` 필드를 명시적으로
 * 보내는 쪽을 우선한다. multipart의 filename은 클라이언트가 임의로 지정하는 값이라
 * 디렉토리 구조가 보존된다는 보장이 없다).
 */
function deriveSlugFromFilename(filename: string): string {
  const normalized = filename.replace(/\\/g, "/").replace(/^\.?\/+/, "");
  return normalized.replace(/\.md$/i, "");
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

    const content = buffer.toString("utf8");
    const result = await writePage(pool, kbId, slug, content, { updatedBy: ctx.githubUser });

    // expectedVersion을 안 넘겼으므로 conflict는 발생하지 않는다 — writePage()가
    // 유니온 타입을 반환하기 때문에 TS를 위해 형태만 좁혀준다.
    if (result.conflict) {
      return reply.code(409).send({
        error: "unexpected version conflict",
        expected: result.expected,
        current: result.current,
      });
    }

    return reply.code(200).send({
      kb_id: kbId,
      slug: result.slug,
      title: result.title,
      version: result.version,
    });
  });
}
