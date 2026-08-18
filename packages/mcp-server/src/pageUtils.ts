// 페이지 콘텐츠 관련 공용 헬퍼. write/append/commit_session 등 여러 경로에서 재사용한다.

/**
 * write()는 spec §4.1 시그니처에 title 인자가 없지만 pages.title은 NOT NULL이라,
 * 콘텐츠의 첫 markdown 헤딩(# ...)을 제목으로 쓰고 없으면 slug 마지막 세그먼트로 대체한다.
 */
export function deriveTitle(slug: string, content: string): string {
  const heading = content.match(/^#\s+(.+)$/m);
  if (heading) return heading[1].trim();
  const lastSegment = slug.split("/").pop();
  return lastSegment ?? slug;
}

/**
 * append 동작의 결합 규칙: 기존 내용 뒤에 추가만 (§4.6). 기존 내용이 비어 있으면
 * 그대로 새 내용, 아니면 줄바꿈으로 구분해 이어붙인다.
 */
export function appendContent(existing: string, addition: string): string {
  if (!existing) return addition;
  return existing.endsWith("\n") ? existing + addition : `${existing}\n${addition}`;
}
