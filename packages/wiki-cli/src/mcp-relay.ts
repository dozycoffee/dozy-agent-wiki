// `wiki-cli mcp`의 핵심: 에이전트(Claude Code 등)와는 stdio로, 실제 MCP 서버와는
// Streamable HTTP로 이어지는 양방향 JSON-RPC 릴레이.
//
// docs/spec.md §4.2 "mcp 서브커맨드 동작":
//   1. cwd에서 `git remote get-url origin` → repo 식별자 추출
//   2. OS 키체인에 저장된 GitHub 토큰 로드
//   3. 실제 MCP 서버로 HTTP 요청 전달 (X-Repo, Authorization 헤더 첨부)
//
// 구현 방식: MCP tool 목록/스키마를 하드코딩하지 않기 위해, McpServer/Client의
// 상위 레벨 API(tool 등록, callTool 등)를 쓰지 않고 Transport 레벨에서 메시지를
// 그대로 주고받는다. 양쪽 SDK(@modelcontextprotocol/server, /client)는 동일한
// `Transport` 인터페이스(start/send/close/onmessage/onerror/onclose)를 구현하므로,
// 로컬 stdio transport에서 받은 JSON-RPC 메시지를 원격 HTTP transport로 그대로
// 넘기고 그 반대도 그대로 넘기면 tool 이름이나 스키마를 전혀 몰라도 모든 tool
// 호출(및 향후 추가되는 resources/prompts 등)이 투명하게 중계된다.
//
// 주의: 이 경로는 stdout으로 JSON-RPC만 흘려야 하므로 모든 로그는 console.error로만
// 남긴다 (AGENTS.md 코딩 컨벤션 참조).

import { StdioServerTransport } from "@modelcontextprotocol/server/stdio";
import { StreamableHTTPClientTransport, type Transport } from "@modelcontextprotocol/client";
import { getRepoIdentifier } from "./repo.js";
import { loadToken } from "./keychain.js";

const DEFAULT_WIKI_SERVER_URL = "http://localhost:8080";

export interface McpRelayOptions {
  /** 테스트용: repo 식별을 어느 디렉토리 기준으로 할지. 기본값은 process.cwd(). */
  cwd?: string;
  /** 테스트용: 실제 MCP 서버 base URL. 기본값은 WIKI_SERVER_URL env, 없으면 localhost:8080. */
  serverUrl?: string;
}

/**
 * stdio(로컬, 에이전트용) <-> Streamable HTTP(원격, 실제 MCP 서버) 릴레이를 시작한다.
 * 이 함수는 로컬/원격 transport가 모두 닫힐 때까지 반환하지 않는다(프로세스가
 * 에이전트의 자식 프로세스로 계속 떠 있어야 하므로).
 */
export async function runMcpRelay(options: McpRelayOptions = {}): Promise<void> {
  const cwd = options.cwd ?? process.cwd();
  const serverUrl =
    options.serverUrl ?? process.env.WIKI_SERVER_URL ?? DEFAULT_WIKI_SERVER_URL;

  const repo = await getRepoIdentifier(cwd);
  if (!repo) {
    console.error(
      "[wiki-cli mcp] git remote 'origin'을 찾을 수 없습니다 (git repo가 아니거나 origin이 없음) — X-Repo 헤더 없이 진행합니다.",
    );
  }

  const token = loadToken();
  if (!token) {
    console.error(
      "[wiki-cli mcp] OS 키체인에서 GitHub 토큰을 찾을 수 없습니다 — 먼저 `wiki-cli login`을 실행하세요. Authorization 헤더 없이 진행합니다.",
    );
  }

  const headers: Record<string, string> = {};
  if (repo) headers["X-Repo"] = repo;
  if (token) headers.Authorization = `Bearer ${token}`;

  const endpoint = new URL("/mcp", serverUrl);
  const remote: Transport = new StreamableHTTPClientTransport(endpoint, {
    requestInit: { headers },
  });
  const local: Transport = new StdioServerTransport();

  let closing = false;
  let resolveShutdown!: () => void;
  const shutdown = new Promise<void>((resolve) => {
    resolveShutdown = resolve;
  });

  const closeBoth = async (reason: string, exitCode: number) => {
    if (closing) return;
    closing = true;
    console.error(`[wiki-cli mcp] 연결 종료: ${reason}`);
    await Promise.allSettled([local.close(), remote.close()]);
    process.exitCode = exitCode;
    resolveShutdown();
  };

  // 에이전트 -> (이 프로세스) -> 실제 MCP 서버
  local.onmessage = (message) => {
    remote.send(message).catch((err: unknown) => {
      console.error("[wiki-cli mcp] 서버로 메시지 전달 실패:", err);
    });
  };
  local.onerror = (err) => {
    console.error("[wiki-cli mcp] stdio transport 오류:", err);
  };
  local.onclose = () => {
    void closeBoth("에이전트가 연결을 닫음", 0);
  };

  // 실제 MCP 서버 -> (이 프로세스) -> 에이전트
  remote.onmessage = (message) => {
    local.send(message).catch((err: unknown) => {
      console.error("[wiki-cli mcp] 에이전트로 메시지 전달 실패:", err);
    });
  };
  remote.onerror = (err) => {
    console.error("[wiki-cli mcp] 원격 MCP 서버 연결 오류:", err);
  };
  remote.onclose = () => {
    void closeBoth("원격 MCP 서버가 연결을 닫음", 1);
  };

  process.on("SIGINT", () => void closeBoth("신호 수신: SIGINT", 0));
  process.on("SIGTERM", () => void closeBoth("신호 수신: SIGTERM", 0));

  await remote.start();
  await local.start();

  console.error(
    `[wiki-cli mcp] relay 시작: stdio <-> ${endpoint.toString()} (repo=${repo ?? "unknown"}, token=${token ? "loaded" : "missing"})`,
  );

  // local/remote 어느 한 쪽이든 닫힐 때까지 대기 (에이전트가 자식 프로세스를 살려두는
  // 한 이 Promise는 세션이 끝날 때까지 resolve되지 않는다).
  await shutdown;
}
