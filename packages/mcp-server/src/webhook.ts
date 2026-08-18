// GitHub 웹훅 기반 KB 사전 프로비저닝 — docs/spec.md §4.4 (선택, MVP 이후)
//
// `repository.created` 이벤트를 받아 project KB를 즉석 생성 로직과 동일한 내부
// 함수(ensureKbProvisioned)로 미리 만들어둔다. 즉석 생성만으로 충분하면 이 경로는
// 안 써도 되지만(spec에 명시), 첫 tool 호출 지연을 없애고 싶을 때를 위해 구현.

import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * GitHub의 `X-Hub-Signature-256` 헤더를 검증한다. secret으로 raw body의 HMAC-SHA256을
 * 계산해 타이밍 공격에 안전하게 비교한다.
 */
export function verifyWebhookSignature(
  secret: string,
  rawBody: Buffer,
  signatureHeader: string | undefined,
): boolean {
  if (!signatureHeader) return false;

  const expected = `sha256=${createHmac("sha256", secret).update(rawBody).digest("hex")}`;
  const expectedBuf = Buffer.from(expected);
  const actualBuf = Buffer.from(signatureHeader);

  if (expectedBuf.length !== actualBuf.length) return false;
  return timingSafeEqual(expectedBuf, actualBuf);
}

export interface RepositoryCreatedPayload {
  action?: string;
  repository?: { full_name?: string };
}

/** payload가 우리가 처리할 `repository.created` 이벤트인지 판별하고 repo full_name을 뽑는다. */
export function extractRepositoryCreated(
  githubEvent: string | undefined,
  payload: unknown,
): string | undefined {
  if (githubEvent !== "repository") return undefined;
  const body = payload as RepositoryCreatedPayload;
  if (body?.action !== "created") return undefined;
  return body.repository?.full_name;
}
