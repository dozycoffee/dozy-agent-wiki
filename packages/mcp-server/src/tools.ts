import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { pool } from "./db.js";
import { authorize, type RequestContext } from "./auth.js";
import { recordAudit } from "./audit.js";
import { writePage } from "./pageWrite.js";

function denied(reason: string | undefined) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: `permission denied: ${reason ?? "unknown reason"}` }],
  };
}

export function registerTools(server: McpServer, ctx: RequestContext): void {
  server.registerTool(
    "search",
    {
      title: "Search",
      description: "org/project/personal KB 통합 또는 지정 검색 (Postgres full-text)",
      inputSchema: z.object({
        query: z.string().min(1),
        kb_scope: z.array(z.string()).optional(),
      }),
    },
    async ({ query, kb_scope }) => {
      // search는 특정 kb_id 하나를 겨냥하지 않는 tool이라(§4.1, kb_scope는 optional/배열)
      // 전체를 허용/거부하는 대신 결과를 readable KB로만 필터링한다 — KB 자동
      // 프로비저닝도 이 tool에서는 트리거하지 않는다 (아직 존재하지 않는 KB는 검색 결과에
      // 나올 수 없으므로 트리거할 이유도 없다).
      if (!ctx.githubUser) {
        await recordAudit(pool, ctx.githubUser, null, "search", false);
        return denied("missing or invalid GitHub token");
      }

      const { rows } = await pool.query(
        `SELECT kb_id, slug, title,
                ts_headline('simple', content_md, plainto_tsquery('simple', $1)) AS snippet
         FROM pages
         WHERE deleted_at IS NULL
           AND search_vec @@ plainto_tsquery('simple', $1)
           AND ($2::text[] IS NULL OR kb_id = ANY($2))
         ORDER BY ts_rank(search_vec, plainto_tsquery('simple', $1)) DESC
         LIMIT 20`,
        [query, kb_scope ?? null],
      );

      const distinctKbIds = [...new Set(rows.map((r) => r.kb_id as string))];
      const readable = new Set<string>();
      for (const kbId of distinctKbIds) {
        const decision = await authorize(ctx, kbId, "read");
        if (decision.allowed) readable.add(kbId);
      }
      const filtered = rows.filter((r) => readable.has(r.kb_id as string));

      await recordAudit(pool, ctx.githubUser, null, "search", true);

      return {
        content: [{ type: "text", text: JSON.stringify(filtered) }],
        structuredContent: { results: filtered },
      };
    },
  );

  server.registerTool(
    "read",
    {
      title: "Read",
      description: "페이지 조회",
      inputSchema: z.object({
        kb_id: z.string(),
        slug: z.string(),
      }),
    },
    async ({ kb_id, slug }) => {
      const decision = await authorize(ctx, kb_id, "read");
      await recordAudit(pool, ctx.githubUser, kb_id, "read", decision.allowed);
      if (!decision.allowed) {
        return denied(decision.reason);
      }

      // read는 존재하지 않는 kb_id를 프로비저닝하지 않는다 — 아직 아무도 쓴 적 없는
      // KB를 조회만 해서는 어차피 페이지가 없으므로 "page not found"가 정확한 응답이고,
      // 빈 KB 껍데기를 만들어봐야 의미가 없다. 프로비저닝은 write에서만 트리거한다.
      const { rows } = await pool.query(
        `SELECT kb_id, slug, title, content_md, version, updated_by, updated_at
         FROM pages
         WHERE kb_id = $1 AND slug = $2 AND deleted_at IS NULL`,
        [kb_id, slug],
      );

      const page = rows[0];
      if (!page) {
        return {
          isError: true,
          content: [{ type: "text", text: `page not found: ${kb_id}/${slug}` }],
        };
      }

      // pages.version은 bigint라 pg가 string으로 반환한다 — write()의 expected_version(number)과
      // 그대로 비교하면 항상 불일치하므로 여기서 number로 정규화해 응답한다.
      const normalized = { ...page, version: Number(page.version) };

      return {
        content: [{ type: "text", text: JSON.stringify(normalized) }],
        structuredContent: normalized,
      };
    },
  );

  server.registerTool(
    "list_kbs",
    {
      title: "List knowledge bases",
      description: "현재 유저가 read 권한을 가진 KB 목록",
      inputSchema: z.object({}),
    },
    async () => {
      if (!ctx.githubUser) {
        await recordAudit(pool, ctx.githubUser, null, "list_kbs", false);
        return denied("missing or invalid GitHub token");
      }

      const { rows } = await pool.query(
        `SELECT id, type, parent_id FROM knowledge_bases WHERE archived = false ORDER BY id`,
      );

      const visible: typeof rows = [];
      for (const kb of rows) {
        const decision = await authorize(ctx, kb.id as string, "read");
        if (decision.allowed) visible.push(kb);
      }

      await recordAudit(pool, ctx.githubUser, null, "list_kbs", true);

      return {
        content: [{ type: "text", text: JSON.stringify(visible) }],
        structuredContent: { kbs: visible },
      };
    },
  );

  server.registerTool(
    "write",
    {
      title: "Write",
      description: "단일 페이지 전체 교체(upsert). expected_version으로 낙관적 잠금 (§4.6)",
      inputSchema: z.object({
        kb_id: z.string(),
        slug: z.string(),
        content: z.string(),
        expected_version: z.number().int().min(0),
      }),
    },
    async ({ kb_id, slug, content, expected_version }) => {
      const decision = await authorize(ctx, kb_id, "write");
      await recordAudit(pool, ctx.githubUser, kb_id, "write", decision.allowed);
      if (!decision.allowed) {
        return denied(decision.reason);
      }

      const result = await writePage(pool, kb_id, slug, content, {
        expectedVersion: expected_version,
        updatedBy: ctx.githubUser,
      });

      if (result.conflict) {
        return {
          isError: true,
          content: [
            {
              type: "text",
              text: `version conflict: expected ${result.expected}, current ${result.current}`,
            },
          ],
          structuredContent: { conflict: true, expected: result.expected, current: result.current },
        };
      }

      return {
        content: [{ type: "text", text: `wrote ${kb_id}/${slug} (version ${result.version})` }],
        structuredContent: { kb_id, slug, title: result.title, version: result.version },
      };
    },
  );
}
