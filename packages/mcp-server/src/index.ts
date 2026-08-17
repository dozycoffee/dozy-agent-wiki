// dozy-agent-wiki MCP 서버 진입점
// 구현 시 docs/spec.md §4.1(tool 목록), §5(권한 모델)을 따를 것.

import Fastify, { type FastifyReply } from "fastify";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { McpServer } from "@modelcontextprotocol/server";
import { registerTools } from "./tools.js";

// TODO(§4.3): GitHub 토큰 검증 미들웨어 (permission_cache 포함)
// TODO(§4.4): KB 즉석 자동 생성 로직 (project/personal, _index/_log 포함)
// TODO(§4.6): commit_session 충돌 감지 (건드린 slug만 FOR UPDATE, 알파벳순 잠금)

const app = Fastify({ logger: true });

app.get("/health", async () => ({ ok: true }));

app.post("/mcp", async (request, reply) => {
  // 세션 없이 요청마다 새 McpServer/transport를 붙이는 stateless 모드.
  const server = new McpServer({ name: "dozy-agent-wiki", version: "0.0.1" });
  registerTools(server);

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
