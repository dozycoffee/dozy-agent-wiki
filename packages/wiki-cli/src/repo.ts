// git remote로부터 repo 식별자를 뽑아내는 헬퍼.
// docs/spec.md §4.2: 매 tool 호출 시 cwd에서 `git remote get-url origin`을 실행해
// repo 식별자를 추출하고 `X-Repo` 헤더로 실제 MCP 서버에 전달한다.

import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/**
 * `git@host:owner/repo.git` / `https://host/owner/repo.git` 등 다양한 remote URL
 * 형태를 `host/owner/repo` 형태의 안정적인 문자열로 정규화한다.
 * (ssh와 https 두 형태가 같은 repo를 가리켜도 동일한 X-Repo 값이 나오게 하기 위함)
 */
export function normalizeRemoteUrl(rawUrl: string): string {
  let s = rawUrl.trim();
  // scp-like ssh 형태: git@host:owner/repo.git -> host/owner/repo.git
  s = s.replace(/^([^@/]+@)?([^:/]+):(?!\/\/)/, "$2/");
  // scheme 제거: ssh://git@host/owner/repo -> host/owner/repo, https://host/... -> host/...
  s = s.replace(/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/(?:[^@/]+@)?/, "");
  // 끝의 .git, 슬래시 정리
  s = s.replace(/\.git\/?$/, "");
  s = s.replace(/\/+$/, "");
  return s;
}

/**
 * 지정한 디렉토리에서 `git remote get-url origin`을 실행해 repo 식별자를 얻는다.
 * git repo가 아니거나 origin remote가 없으면 undefined를 반환한다 (throw하지 않음 —
 * 이 값이 없어도 relay 자체는 계속 동작해야 하므로 서버 쪽에서 X-Repo 없음을 처리한다).
 */
export async function getRepoIdentifier(cwd: string): Promise<string | undefined> {
  try {
    const { stdout } = await execFileAsync("git", ["remote", "get-url", "origin"], {
      cwd,
    });
    const url = stdout.trim();
    if (!url) return undefined;
    return normalizeRemoteUrl(url);
  } catch {
    return undefined;
  }
}
