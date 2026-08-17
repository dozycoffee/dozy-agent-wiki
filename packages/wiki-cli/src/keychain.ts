// OS 키체인(macOS Keychain / Windows Credential Manager / libsecret)에
// GitHub 토큰을 저장/조회/삭제하는 헬퍼.
// docs/spec.md §4.3: 토큰은 평문 파일이 아닌 OS 키체인에 저장한다.
//
// @napi-rs/keyring: 플랫폼별 prebuilt binary(optionalDependencies)로 배포되는
// keyring-rs(https://github.com/hwchen/keyring-rs)의 Node 바인딩.
// macOS Keychain / Windows Credential Manager / (Linux) libsecret을 하나의 API로 감싼다.
import { Entry } from "@napi-rs/keyring";

const SERVICE = "dozy-agent-wiki";
const ACCOUNT = "github-token";

function entry(): Entry {
  return new Entry(SERVICE, ACCOUNT);
}

/** GitHub 토큰을 OS 키체인에 저장한다. */
export function saveToken(token: string): void {
  entry().setPassword(token);
}

/**
 * OS 키체인에서 GitHub 토큰을 읽는다.
 * 저장된 값이 없거나 플랫폼 keyring 접근이 실패하면 undefined를 반환한다
 * (호출부에서 "로그인 필요" 안내로 이어지도록 throw하지 않는다).
 */
export function loadToken(): string | undefined {
  try {
    const value = entry().getPassword();
    return value ?? undefined;
  } catch {
    return undefined;
  }
}

/** OS 키체인에서 저장된 GitHub 토큰을 삭제한다. 삭제된 항목이 있었으면 true. */
export function deleteToken(): boolean {
  try {
    return entry().deleteCredential();
  } catch {
    return false;
  }
}
