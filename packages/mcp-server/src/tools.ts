import type { McpServer } from "@modelcontextprotocol/server";
import { z } from "zod";
import { pool } from "./db.js";
import { authorize, type RequestContext } from "./auth.js";
import { ensureKbProvisioned } from "./provisioning.js";
import { recordAudit } from "./audit.js";
import { getKbVersion, getKbVersions } from "./kbVersions.js";
import { commitChanges, type CommitResult } from "./commit.js";

function denied(reason: string | undefined) {
  return {
    isError: true,
    content: [{ type: "text" as const, text: `permission denied: ${reason ?? "unknown reason"}` }],
  };
}

/**
 * commitChanges()의 결과를 tool 응답으로 번역한다. write/append/delete/revert
 * shorthand가 모두 이 헬퍼를 공유한다 (§4.6, commit.ts 참고).
 */
function respondFromCommit(kbId: string, result: CommitResult, verb: string) {
  if (result.status === "conflict") {
    const [first] = result.conflicts;
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: `version conflict: expected ${first.expected}, current ${first.current}`,
        },
      ],
      structuredContent: { conflict: true, conflicts: result.conflicts },
    };
  }

  const [applied] = result.results;
  return {
    content: [
      {
        type: "text" as const,
        text: `${verb} ${kbId}/${applied.slug} (version ${applied.version})`,
      },
    ],
    structuredContent: { kb_id: kbId, ...applied },
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

      // §3.3: read/search 응답에 결과가 속한 KB의 현재 워터마크를 함께 반환한다.
      const kbVersions = await getKbVersions(pool, [...readable]);
      const withVersion = filtered.map((r) => ({
        ...r,
        kb_version: kbVersions.get(r.kb_id as string) ?? 0,
      }));

      await recordAudit(pool, ctx.githubUser, null, "search", true);

      return {
        content: [{ type: "text", text: JSON.stringify(withVersion) }],
        structuredContent: { results: withVersion },
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
      // kb_version은 pages.version(페이지별 낙관적 잠금)과는 별개인 KB 전체 워터마크(§3.3).
      const kbVersion = await getKbVersion(pool, kb_id);
      const normalized = { ...page, version: Number(page.version), kb_version: kbVersion };

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

      // write는 spec §4.6에 "open+stage_write+commit의 shorthand"로 명시돼 있다 —
      // 공용 commitChanges()(§4.6 pseudocode 구현체, commit.ts)를 단일 변경으로 호출한다.
      const result = await commitChanges(pool, kb_id, ctx.githubUser, [
        { slug, action: "write", content, expectedVersion: expected_version },
      ]);

      return respondFromCommit(kb_id, result, "wrote");
    },
  );

  server.registerTool(
    "append",
    {
      title: "Append",
      description: "단일 페이지 뒤에 내용 추가(전체 교체 아님). expected_version으로 낙관적 잠금 (§4.6)",
      inputSchema: z.object({
        kb_id: z.string(),
        slug: z.string(),
        content: z.string(),
        expected_version: z.number().int().min(0),
      }),
    },
    async ({ kb_id, slug, content, expected_version }) => {
      const decision = await authorize(ctx, kb_id, "write");
      await recordAudit(pool, ctx.githubUser, kb_id, "append", decision.allowed);
      if (!decision.allowed) {
        return denied(decision.reason);
      }

      await ensureKbProvisioned(pool, kb_id);

      const result = await commitChanges(pool, kb_id, ctx.githubUser, [
        { slug, action: "append", content, expectedVersion: expected_version },
      ]);

      return respondFromCommit(kb_id, result, "appended to");
    },
  );

  server.registerTool(
    "delete",
    {
      title: "Delete",
      description:
        "단일 페이지 삭제. KB 유형별 문턱이 다르다(§5.1) — org/project는 관리자만+soft-delete, personal은 본인+즉시 삭제",
      inputSchema: z.object({
        kb_id: z.string(),
        slug: z.string(),
        expected_version: z.number().int().min(0),
      }),
    },
    async ({ kb_id, slug, expected_version }) => {
      const decision = await authorize(ctx, kb_id, "delete");
      await recordAudit(pool, ctx.githubUser, kb_id, "delete", decision.allowed);
      if (!decision.allowed) {
        return denied(decision.reason);
      }

      // delete는 새 KB를 만들 이유가 없는 destructive tool이라 프로비저닝을 트리거하지 않는다.
      const result = await commitChanges(pool, kb_id, ctx.githubUser, [
        { slug, action: "delete", expectedVersion: expected_version },
      ]);

      return respondFromCommit(kb_id, result, "deleted");
    },
  );

  server.registerTool(
    "revert",
    {
      title: "Revert",
      description: "pages_history의 특정 시점 내용으로 복원 (페이지 version도 함께 증가) (§4.6)",
      inputSchema: z.object({
        kb_id: z.string(),
        slug: z.string(),
        history_id: z.number().int(),
      }),
    },
    async ({ kb_id, slug, history_id }) => {
      const decision = await authorize(ctx, kb_id, "write");
      await recordAudit(pool, ctx.githubUser, kb_id, "revert", decision.allowed);
      if (!decision.allowed) {
        return denied(decision.reason);
      }

      const { rows: histRows } = await pool.query<{ content_md: string }>(
        `SELECT content_md FROM pages_history WHERE id = $1 AND kb_id = $2 AND slug = $3`,
        [history_id, kb_id, slug],
      );
      const historyEntry = histRows[0];
      if (!historyEntry) {
        return {
          isError: true,
          content: [
            { type: "text", text: `history entry not found: id=${history_id} for ${kb_id}/${slug}` },
          ],
        };
      }

      // revert(kb_id, slug, history_id)는 spec 시그니처에 expected_version이 없다 —
      // 커밋 직전 실제 현재 버전을 읽어 그걸 expected로 넘긴다. commitChanges()의 FOR
      // UPDATE 잠금 안에서 다시 한 번 검증되므로, 이 사이 짧은 TOCTOU 창이 있어도 최종
      // 정합성은 깨지지 않는다(그 사이 다른 변경이 있었으면 그냥 conflict로 거부됨).
      const { rows: curRows } = await pool.query<{ version: string }>(
        `SELECT version FROM pages WHERE kb_id = $1 AND slug = $2 AND deleted_at IS NULL`,
        [kb_id, slug],
      );
      const expectedVersion = curRows[0] ? Number(curRows[0].version) : 0;

      const result = await commitChanges(pool, kb_id, ctx.githubUser, [
        {
          slug,
          action: "write",
          content: historyEntry.content_md,
          expectedVersion,
          historyLabel: "revert",
        },
      ]);

      return respondFromCommit(kb_id, result, "reverted");
    },
  );

  server.registerTool(
    "list_pages",
    {
      title: "List pages",
      description: "KB 내 slug 목록 조회, category(§3.2 GENERATED 컬럼)별 그룹핑 (§4.1)",
      inputSchema: z.object({
        kb_id: z.string(),
        prefix: z.string().optional(),
      }),
    },
    async ({ kb_id, prefix }) => {
      const decision = await authorize(ctx, kb_id, "read");
      await recordAudit(pool, ctx.githubUser, kb_id, "list_pages", decision.allowed);
      if (!decision.allowed) {
        return denied(decision.reason);
      }

      const { rows } = await pool.query(
        `SELECT slug, title, category, version, updated_at
         FROM pages
         WHERE kb_id = $1 AND deleted_at IS NULL
           AND ($2::text IS NULL OR slug LIKE $2 || '%')
         ORDER BY category, slug`,
        [kb_id, prefix ?? null],
      );

      const pages = rows.map((r) => ({ ...r, version: Number(r.version) }));
      const byCategory: Record<string, typeof pages> = {};
      for (const page of pages) {
        const key = page.category as string;
        (byCategory[key] ??= []).push(page);
      }

      return {
        content: [{ type: "text", text: JSON.stringify(pages) }],
        structuredContent: { pages, by_category: byCategory },
      };
    },
  );

  server.registerTool(
    "lint",
    {
      title: "Lint",
      description: "KB 내 깨진 링크(존재하지 않는 slug를 가리키는 markdown 링크)/고아 페이지 점검",
      inputSchema: z.object({
        kb_id: z.string(),
      }),
    },
    async ({ kb_id }) => {
      const decision = await authorize(ctx, kb_id, "read");
      await recordAudit(pool, ctx.githubUser, kb_id, "lint", decision.allowed);
      if (!decision.allowed) {
        return denied(decision.reason);
      }

      const { rows } = await pool.query<{ slug: string; content_md: string }>(
        `SELECT slug, content_md FROM pages WHERE kb_id = $1 AND deleted_at IS NULL`,
        [kb_id],
      );

      const existingSlugs = new Set(rows.map((r) => r.slug));
      const linkedSlugs = new Set<string>();
      const brokenLinks: Array<{ from_slug: string; target: string }> = [];

      // 링크 규약(spec에 명시돼 있지 않아 이 구현에서 채택): markdown 링크
      // `[text](target)`와 위키링크 `[[target]]` 둘 다 지원. `http(s)://`, `mailto:`,
      // `#`으로 시작하는 target은 KB 내부 slug 참조가 아니므로 제외한다.
      const mdLinkRe = /\[[^\]]*\]\(([^)\s]+)\)/g;
      const wikiLinkRe = /\[\[([^\]|]+)(?:\|[^\]]*)?\]\]/g;

      function normalizeTarget(raw: string): string {
        return raw.replace(/^\.\//, "").replace(/#.*$/, "").trim();
      }

      function isExternal(raw: string): boolean {
        return /^(https?:|mailto:|#)/i.test(raw);
      }

      for (const page of rows) {
        for (const match of page.content_md.matchAll(mdLinkRe)) {
          const raw = match[1];
          if (isExternal(raw)) continue;
          const target = normalizeTarget(raw);
          if (!target) continue;
          linkedSlugs.add(target);
          if (!existingSlugs.has(target)) {
            brokenLinks.push({ from_slug: page.slug, target });
          }
        }
        for (const match of page.content_md.matchAll(wikiLinkRe)) {
          const target = normalizeTarget(match[1]);
          if (!target) continue;
          linkedSlugs.add(target);
          if (!existingSlugs.has(target)) {
            brokenLinks.push({ from_slug: page.slug, target });
          }
        }
      }

      // 고아 페이지: 예약 페이지(_index, _log)는 애초에 다른 페이지에서 링크되지 않는
      // 진입점이라 판정에서 제외한다.
      const orphanPages = [...existingSlugs].filter(
        (slug) => slug !== "_index" && slug !== "_log" && !linkedSlugs.has(slug),
      );

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ broken_links: brokenLinks, orphan_pages: orphanPages }),
          },
        ],
        structuredContent: { broken_links: brokenLinks, orphan_pages: orphanPages },
      };
    },
  );

  server.registerTool(
    "get_kb_version",
    {
      title: "Get KB version",
      description: "KB 전체 워터마크(버전 카운터) 조회 — stale 감지용 (§3.3)",
      inputSchema: z.object({
        kb_id: z.string(),
      }),
    },
    async ({ kb_id }) => {
      const decision = await authorize(ctx, kb_id, "read");
      await recordAudit(pool, ctx.githubUser, kb_id, "get_kb_version", decision.allowed);
      if (!decision.allowed) {
        return denied(decision.reason);
      }

      const version = await getKbVersion(pool, kb_id);

      return {
        content: [{ type: "text", text: JSON.stringify({ version }) }],
        structuredContent: { version },
      };
    },
  );
}
