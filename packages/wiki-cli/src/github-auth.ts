// GitHub OAuth Device Flow 구현.
// docs/spec.md §4.3: `wiki-cli login`은 GitHub OAuth로 최초 1회 로그인하고
// 발급받은 토큰을 OS 키체인에 저장한다.
//
// Device Flow를 택한 이유:
// - 이 CLI는 npm으로 배포되는 public 클라이언트라 client secret을 안전하게 담을
//   곳이 없다. Device Flow는 client_id만으로 동작하도록 설계돼 있어 secret이
//   필요 없다 (Authorization Code + PKCE도 secret 없이 가능하지만, 로컬에 redirect를
//   받을 HTTP 서버를 띄워야 해서 포트 충돌/방화벽 이슈가 생긴다).
// - 로컬 리스너가 필요 없어 SSH 세션이나 컨테이너 등 브라우저가 CLI와 같은 머신에
//   없는 환경에서도 동작한다 (다른 기기에서 verification_uri를 열고 코드만 입력하면 됨).
// - GitHub CLI(`gh auth login`)도 동일한 방식을 쓴다 — 사내 개발자들이 이미 익숙한 UX.

const DEVICE_CODE_URL = "https://github.com/login/device/code";
const ACCESS_TOKEN_URL = "https://github.com/login/oauth/access_token";

/** 서버(mcp-server)가 GitHub API로 collaborator 권한을 조회할 수 있어야 하므로 repo 스코프 포함. */
const DEFAULT_SCOPE = "read:user repo";

export interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

interface DeviceCodeErrorResponse {
  error: string;
  error_description?: string;
}

/** 사내 GitHub OAuth App의 client id. mcp-server와 동일한 App을 사용한다 (docker-compose.yml GITHUB_OAUTH_CLIENT_ID 참조). */
export function getClientId(): string {
  const clientId = process.env.GITHUB_OAUTH_CLIENT_ID;
  if (!clientId) {
    throw new Error(
      "GITHUB_OAUTH_CLIENT_ID 환경변수가 설정되어 있지 않습니다. 사내 GitHub OAuth App의 client id를 설정한 뒤 다시 시도하세요.",
    );
  }
  return clientId;
}

export async function requestDeviceCode(
  clientId: string,
  scope: string = DEFAULT_SCOPE,
): Promise<DeviceCodeResponse> {
  const res = await fetch(DEVICE_CODE_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ client_id: clientId, scope }),
  });

  const data = (await res.json()) as DeviceCodeResponse | DeviceCodeErrorResponse;
  if (!res.ok || "error" in data) {
    const err = data as DeviceCodeErrorResponse;
    throw new Error(
      `device code 요청 실패 (HTTP ${res.status}): ${err.error ?? "unknown"} ${err.error_description ?? ""}`.trim(),
    );
  }
  return data;
}

interface AccessTokenSuccess {
  access_token: string;
  token_type: string;
  scope: string;
}

interface AccessTokenPendingOrError {
  error: "authorization_pending" | "slow_down" | "expired_token" | "access_denied" | string;
  error_description?: string;
}

async function pollOnce(
  clientId: string,
  deviceCode: string,
): Promise<AccessTokenSuccess | AccessTokenPendingOrError> {
  const res = await fetch(ACCESS_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: clientId,
      device_code: deviceCode,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }),
  });
  return (await res.json()) as AccessTokenSuccess | AccessTokenPendingOrError;
}

export interface PollOptions {
  /** authorization_pending일 때마다 호출 (진행 상황 표시용) */
  onPending?: () => void;
}

/**
 * user_code가 사용자에 의해 승인될 때까지 폴링해 access token을 받아온다.
 * GitHub의 device flow 폴링 규약(interval, slow_down, expired_token 등)을 따른다.
 */
export async function pollForAccessToken(
  clientId: string,
  device: DeviceCodeResponse,
  options: PollOptions = {},
): Promise<string> {
  let intervalMs = device.interval * 1000;
  const deadline = Date.now() + device.expires_in * 1000;

  while (Date.now() < deadline) {
    await sleep(intervalMs);
    const result = await pollOnce(clientId, device.device_code);

    if ("access_token" in result) {
      return result.access_token;
    }

    switch (result.error) {
      case "authorization_pending":
        options.onPending?.();
        continue;
      case "slow_down":
        // GitHub 권장: 이후 폴링 간격을 5초 늘림
        intervalMs += 5000;
        continue;
      case "expired_token":
        throw new Error("device code가 만료되었습니다. `wiki-cli login`을 다시 실행하세요.");
      case "access_denied":
        throw new Error("로그인 요청이 거부되었습니다.");
      default:
        throw new Error(
          `토큰 발급 실패: ${result.error}${result.error_description ? ` - ${result.error_description}` : ""}`,
        );
    }
  }

  throw new Error("device code가 만료되었습니다. `wiki-cli login`을 다시 실행하세요.");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** GitHub `GET /user`로 토큰 유효성을 확인하고 로그인한 사용자 정보를 반환한다 (docs/spec.md §4.3). */
export async function fetchGitHubUser(token: string): Promise<{ login: string }> {
  const res = await fetch("https://api.github.com/user", {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });
  if (!res.ok) {
    throw new Error(`GitHub 사용자 조회 실패: HTTP ${res.status}`);
  }
  return (await res.json()) as { login: string };
}
