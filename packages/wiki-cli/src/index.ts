#!/usr/bin/env node
// dozy-agent-wiki CLI 진입점
// 구현 시 docs/spec.md §4.2(wiki-cli 서브커맨드), §4.3(인증)을 따를 것.
//
// 주의: `mcp` 서브커맨드는 stdout으로 JSON-RPC를 주고받으므로,
// 이 경로에서는 어떤 로그도 stdout에 출력하지 말 것 (console.error만 사용).

import { Command } from "commander";

const program = new Command();

program.name("wiki-cli").description("dozy-agent-wiki 클라이언트 CLI");

program
  .command("mcp")
  .description("stdio 기반 로컬 MCP 서버로 실행 (에이전트가 자동 실행)")
  .action(async () => {
    // TODO(§4.2): git remote get-url origin → repo 식별자 추출
    // TODO(§4.2): OS 키체인에서 GitHub 토큰 로드
    // TODO(§4.2): StdioServerTransport로 MCP tool을 실제 서버(HTTP)로 중계
    console.error("[wiki-cli mcp] not implemented yet");
    process.exit(1);
  });

program
  .command("push <file>")
  .option("--kb <kb_id>", "대상 knowledge base id")
  .description("md 파일을 지정한 KB에 업로드 (§4.5)")
  .action(async (file: string, opts: { kb?: string }) => {
    // TODO(§4.5): POST /api/kb/{kb_id}/pages 로 multipart 업로드
    console.log(`[wiki-cli push] not implemented yet: ${file} -> ${opts.kb}`);
  });

program
  .command("login")
  .description("GitHub OAuth 로그인, 토큰을 OS 키체인에 저장 (§4.3)")
  .action(async () => {
    // TODO(§4.3): GitHub OAuth device flow 또는 브라우저 플로우
    console.log("[wiki-cli login] not implemented yet");
  });

program
  .command("whoami")
  .description("현재 로그인 상태/권한 진단")
  .action(async () => {
    // TODO: 캐시된 토큰으로 GitHub /user 조회 후 출력
    console.log("[wiki-cli whoami] not implemented yet");
  });

program.parse();
