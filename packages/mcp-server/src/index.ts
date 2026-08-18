// dozy-agent-wiki MCP 서버 진입점
// 구현 시 docs/spec.md §4.1(tool 목록), §5(권한 모델)을 따를 것.

import Fastify, { type FastifyReply, type FastifyRequest } from "fastify";
import fastifyMultipart from "@fastify/multipart";
import { NodeStreamableHTTPServerTransport } from "@modelcontextprotocol/node";
import { McpServer } from "@modelcontextprotocol/server";
import { registerTools } from "./tools.js";
import { buildRequestContext } from "./auth.js";
import { pool } from "./db.js";
import { ensureKbProvisioned } from "./provisioning.js";
import { verifyWebhookSignature, extractRepositoryCreated } from "./webhook.js";
import { registerPushRoute } from "./pushRoute.js";

const app = Fastify({ logger: true });

// 기본 JSON 파서를 buffer로 받은 뒤 직접 파싱하도록 교체 — /webhooks/github의
// HMAC 서명 검증(§4.4)에 raw body 바이트가 필요하기 때문. request.body는 여전히
// 파싱된 객체로 채워지므로 /mcp 등 다른 라우트의 동작은 그대로다.
app.addContentTypeParser(
  "application/json",
  { parseAs: "buffer" },
  (request, body: Buffer, done) => {
    (request as FastifyRequest & { rawBody?: Buffer }).rawBody = body;
    if (body.length === 0) {
      done(null, undefined);
      return;
    }
    try {
      done(null, JSON.parse(body.toString("utf8")));
    } catch (err) {
      done(err as Error, undefined);
    }
  },
);

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

// GitHub 웹훅 기반 KB 사전 프로비저닝 — §4.4 (선택, MVP 이후). `repository.created`
// 이벤트에서 project KB를 즉석 생성과 동일한 ensureKbProvisioned()로 미리 만든다.
//
// GITHUB_WEBHOOK_SECRET 미설정 시 501로 거부한다 — 서명 검증 없이 이 엔드포인트를
// 열어두면 누구나 임의의 owner/repo 이름으로 project KB를 미리 생성시킬 수 있다
// (ensureKbProvisioned 자체는 멱등/무해하지만, 인증 없는 공개 엔드포인트로 임의
// 스팸 생성이 가능해지는 건 피하는 게 안전한 기본값이라 판단 — WIKI_ADMINS
// 미설정 시 "org write 전원 거부"로 처리한 §5.1과 같은 원칙).
app.post("/webhooks/github", async (request, reply) => {
  const secret = process.env.GITHUB_WEBHOOK_SECRET;
  if (!secret) {
    return reply.code(501).send({ error: "GITHUB_WEBHOOK_SECRET is not configured" });
  }

  const rawBody = (request as FastifyRequest & { rawBody?: Buffer }).rawBody;
  const signatureHeader = request.headers["x-hub-signature-256"];
  const signature = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;

  if (!rawBody || !verifyWebhookSignature(secret, rawBody, signature)) {
    return reply.code(401).send({ error: "invalid signature" });
  }

  const eventHeader = request.headers["x-github-event"];
  const event = Array.isArray(eventHeader) ? eventHeader[0] : eventHeader;
  const repoFullName = extractRepositoryCreated(event, request.body);

  if (repoFullName) {
    await ensureKbProvisioned(pool, repoFullName);
  }

  return reply.code(204).send();
});

const port = Number(process.env.PORT ?? 8080);

app.listen({ port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
