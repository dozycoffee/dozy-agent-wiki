import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { pool } from "./db.js";

export function registerTools(server: McpServer): void {
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

      return {
        content: [{ type: "text", text: JSON.stringify(rows) }],
        structuredContent: { results: rows },
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

      return {
        content: [{ type: "text", text: JSON.stringify(page) }],
        structuredContent: page,
      };
    },
  );

  server.registerTool(
    "list_kbs",
    {
      title: "List knowledge bases",
      // 권한 필터링(§4.3 인증 미들웨어) 붙기 전까지는 archived 아닌 전체 KB를 반환한다.
      description: "현재 존재하는 KB 목록",
      inputSchema: z.object({}),
    },
    async () => {
      const { rows } = await pool.query(
        `SELECT id, type, parent_id FROM knowledge_bases WHERE archived = false ORDER BY id`,
      );

      return {
        content: [{ type: "text", text: JSON.stringify(rows) }],
        structuredContent: { kbs: rows },
      };
    },
  );
}
