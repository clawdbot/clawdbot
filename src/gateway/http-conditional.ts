// HTTP conditional requests use weak entity-tag comparison for representation reuse.
export function matchesHttpIfNoneMatch(
  header: string | string[] | undefined,
  etag: string,
): boolean {
  const value = Array.isArray(header) ? header.join(",") : header;
  if (!value) {
    return false;
  }
  const currentTag = etag.startsWith("W/") ? etag.slice(2) : etag;
  return value.split(",").some((candidate) => {
    const tag = candidate.trim();
    const candidateTag = tag.startsWith("W/") ? tag.slice(2) : tag;
    return tag === "*" || candidateTag === currentTag;
  });
}
