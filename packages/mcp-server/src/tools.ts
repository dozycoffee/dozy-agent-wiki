import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { pool } from "./db.js";
import { authorize, type RequestContext } from "./auth.js";
import { ensureKbProvisioned } from "./provisioning.js";
import { recordAudit } from "./audit.js";

// write()는 spec §4.1 시그니처에 title 인자가 없지만 pages.title은 NOT NULL이라,
// 콘텐츠의 첫 markdown 헤딩(# ...)을 제목으로 쓰고 없으면 slug 마지막 세그먼트로 대체한다.
function deriveTitle(slug: string, content: string): string {
  const heading = content.match(/^#\s+(.+)$/m);
  if (heading) return heading[1].trim();
  const lastSegment = slug.split("/").pop();
  return lastSegment ?? slug;
}

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

      // write는 대상 kb_id를 명확히 겨냥하는 tool이라(§4.4) 여기서 KB 즉석 프로비저닝을
      // 트리거한다 — authorize()가 이미 통과했으므로(project: read≥, personal: 본인)
      // 이 요청은 해당 KB에 정당하게 접근 가능하다.
      await ensureKbProvisioned(pool, kb_id);

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
            `UPDATE pages SET content_md = $3, title = $4, updated_by = $5, version = version + 1, updated_at = now()
             WHERE kb_id = $1 AND slug = $2`,
            [kb_id, slug, content, title, ctx.githubUser],
          );
        } else {
          await client.query(
            `INSERT INTO pages (kb_id, slug, title, content_md, updated_by) VALUES ($1, $2, $3, $4, $5)`,
            [kb_id, slug, title, content, ctx.githubUser],
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
