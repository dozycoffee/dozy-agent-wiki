// _index 재생성 — docs/spec.md §3.1, §21(nightly 자동 컴파일 이슈의 "비교적 명확한 부분")
//
// nightly routine 전체(원본 자료를 어디서 가져와 무엇을 반영할지)는 아직 설계가
// 확정되지 않았지만(docs/spec.md 신규 §4.8 참고), "KB 내 페이지 slug들을 훑어서
// 목차를 재구성"하는 부분만은 spec에 명확히 정의돼 있어 이 부분만 먼저 구현한다.

export interface PageSummary {
  slug: string;
  title: string;
  category: string;
}

/**
 * KB 내 페이지 목록(_index 자신은 제외)으로 `_index` 페이지의 markdown 본문을
 * 재구성한다. category(§3.2 GENERATED 컬럼, slug의 첫 세그먼트)별로 묶어 나열한다.
 */
export function renderIndex(pages: PageSummary[]): string {
  const byCategory = new Map<string, PageSummary[]>();
  for (const page of pages) {
    if (page.slug === "_index") continue;
    const list = byCategory.get(page.category);
    if (list) {
      list.push(page);
    } else {
      byCategory.set(page.category, [page]);
    }
  }

  const categories = [...byCategory.keys()].sort();
  const lines: string[] = ["# Index", ""];

  if (categories.length === 0) {
    lines.push("_(아직 페이지가 없습니다)_");
    return lines.join("\n");
  }

  for (const category of categories) {
    lines.push(`## ${category}`, "");
    const items = [...byCategory.get(category)!].sort((a, b) => a.slug.localeCompare(b.slug));
    for (const item of items) {
      lines.push(`- [${item.title}](${item.slug})`);
    }
    lines.push("");
  }

  return lines.join("\n").trimEnd() + "\n";
}
