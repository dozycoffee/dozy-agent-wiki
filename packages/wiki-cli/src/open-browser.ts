// `wiki-cli login`에서 verification_uri를 자동으로 열어주기 위한 best-effort 헬퍼.
// 실패해도 치명적이지 않다 — 사용자가 터미널에 출력된 URL을 직접 열면 되므로
// 항상 예외를 삼키고 boolean으로만 성공 여부를 알린다.
import { exec } from "node:child_process";

export function openBrowser(url: string): Promise<boolean> {
  return new Promise((resolve) => {
    const command =
      process.platform === "darwin"
        ? `open "${url}"`
        : process.platform === "win32"
          ? `start "" "${url}"`
          : `xdg-open "${url}"`;

    exec(command, (err) => resolve(!err));
  });
}
