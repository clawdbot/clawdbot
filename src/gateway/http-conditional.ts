// HTTP conditional requests use weak entity-tag comparison for representation reuse.
export function matchesHttpIfNoneMatch(
  header: string | string[] | undefined,
  etag: string,
): boolean {
  const value = Array.isArray(header) ? header.join(",") : header;
  if (!value) {
    return false;
  }
  return value.split(",").some((candidate) => {
    const tag = candidate.trim();
    return tag === "*" || tag === etag || (tag.startsWith("W/") && tag.slice(2) === etag);
  });
}
