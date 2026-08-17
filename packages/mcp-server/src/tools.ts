import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { pool } from "./db.js";

// write()는 spec §4.1 시그니처에 title 인자가 없지만 pages.title은 NOT NULL이라,
// 콘텐츠의 첫 markdown 헤딩(# ...)을 제목으로 쓰고 없으면 slug 마지막 세그먼트로 대체한다.
function deriveTitle(slug: string, content: string): string {
  const heading = content.match(/^#\s+(.+)$/m);
  if (heading) return heading[1].trim();
  const lastSegment = slug.split("/").pop();
  return lastSegment ?? slug;
}

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
      const client = await pool.connect();
      try {
        await client.query("BEGIN");

        const { rows } = await client.query(
          `SELECT version, content_md FROM pages WHERE kb_id = $1 AND slug = $2 FOR UPDATE`,
          [kb_id, slug],
        );
        const existing = rows[0] as { version: string; content_md: string } | undefined;
        // pages.version은 bigint → pg가 string으로 반환한다. expected_version(number)과
        // 문자열 대 숫자로 비교하면 항상 불일치("1" !== 1) 판정되므로 Number로 정규화한다.
        const current = existing ? Number(existing.version) : 0;

        if (current !== expected_version) {
          await client.query("ROLLBACK");
          return {
            isError: true,
            content: [
              {
                type: "text",
                text: `version conflict: expected ${expected_version}, current ${current}`,
              },
            ],
            structuredContent: { conflict: true, expected: expected_version, current },
          };
        }

        const title = deriveTitle(slug, content);

        if (existing) {
          await client.query(
            `INSERT INTO pages_history (kb_id, slug, content_md, action) VALUES ($1, $2, $3, 'write')`,
            [kb_id, slug, existing.content_md],
          );
          await client.query(
            `UPDATE pages SET content_md = $3, title = $4, version = version + 1, updated_at = now()
             WHERE kb_id = $1 AND slug = $2`,
            [kb_id, slug, content, title],
          );
        } else {
          await client.query(
            `INSERT INTO pages (kb_id, slug, title, content_md) VALUES ($1, $2, $3, $4)`,
            [kb_id, slug, title, content],
          );
        }

        await client.query("COMMIT");

        return {
          content: [{ type: "text", text: `wrote ${kb_id}/${slug} (version ${current + 1})` }],
          structuredContent: { kb_id, slug, title, version: current + 1 },
        };
      } catch (err) {
        await client.query("ROLLBACK");
        throw err;
      } finally {
        client.release();
      }
    },
  );
}
