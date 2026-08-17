// dozy-agent-wiki MCP 서버 진입점
// 구현 시 docs/spec.md §4.1(tool 목록), §5(권한 모델)을 따를 것.

import Fastify from "fastify";

const app = Fastify({ logger: true });

app.get("/health", async () => ({ ok: true }));

// TODO(§4.1): MCP tool 등록 — search, read, list_kbs, write(shorthand) 순으로 1차 구현
// TODO(§4.3): GitHub 토큰 검증 미들웨어 (permission_cache 포함)
// TODO(§4.4): KB 즉석 자동 생성 로직 (project/personal, _index/_log 포함)
// TODO(§4.6): commit_session 충돌 감지 (건드린 slug만 FOR UPDATE, 알파벳순 잠금)

const port = Number(process.env.PORT ?? 8080);

app.listen({ port, host: "0.0.0.0" }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
