// dozy-agent-wiki MCP 서버 진입점
// 구현 시 docs/spec.md §4.1(tool 목록), §5(권한 모델)을 따를 것.

import Fastify, { type FastifyReply } from "fastify";
import fastifyMultipart from "@fastify/multipart";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { McpServer } from "@modelcontextprotocol/server";
import { registerTools } from "./tools.js";
import { buildRequestContext } from "./auth.js";
import { pool } from "./db.js";
import { registerPushRoute } from "./pushRoute.js";

// TODO(§4.6): commit_session 충돌 감지 (건드린 slug만 FOR UPDATE, 알파벳순 잠금)

const app = Fastify({ logger: true });

// POST /api/kb/{kb_id}/pages(§4.5)의 multipart 파일 업로드 파싱용. /mcp(JSON-RPC)
// 경로는 이 플러그인과 무관 — Fastify content-type parser는 등록된 라우트에만 붙는다.
app.register(fastifyMultipart);

app.get("/health", async () => ({ ok: true }));

registerPushRoute(app, pool);

app.post("/mcp", async (request, reply) => {
  // 세션 없이 요청마다 새 McpServer/transport를 붙이는 stateless 모드.
  // 이 지점에서 아직 tool이 등록되기 전이라 request.headers에 바로 접근할 수 있다 —
  // 여기서 Authorization/X-Repo를 읽어 identity를 확정하고, 그 결과를 tool 클로저가
  // 캡처하도록 registerTools(server, ctx)로 넘긴다 (§4.3, §5.2 1단계).
  const ctx = await buildRequestContext(request, pool);

  const server = new McpServer({ name: "dozy-agent-wiki", version: "0.0.1" });
  registerTools(server, ctx);

  const transport = new NodeStreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  await server.connect(transport);

  reply.raw.on("close", () => {
    transport.close();
    server.close();
  });

  await transport.handleRequest(request.raw, reply.raw, request.body);
});

const methodNotAllowed = async (reply: FastifyReply) => {
  await reply.code(405).send({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed" },
    id: null,
  });
};

app.get("/mcp", (_request, reply) => methodNotAllowed(reply));
app.delete("/mcp", (_request, reply) => methodNotAllowed(reply));

const port = Number(process.env.PORT ?? 8080);

app.listen({ port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
