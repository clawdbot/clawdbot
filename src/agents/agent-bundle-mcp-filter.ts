/** Match the documented MCP tool-filter glob syntax: exact text plus `*`. */
export function matchesMcpToolFilterPattern(pattern: string, value: string): boolean {
  const trimmed = pattern.trim();
  if (!trimmed) {
    return false;
  }
  if (!trimmed.includes("*")) {
    return trimmed === value;
  }

  const parts = trimmed.split("*");
  const first = parts[0] ?? "";
  const last = parts.at(-1) ?? "";
  let cursor = 0;
  if (first) {
    if (!value.startsWith(first)) {
      return false;
    }
    cursor = first.length;
  }
  const endBound = last ? value.length - last.length : value.length;
  if (last && (!value.endsWith(last) || endBound < cursor)) {
    return false;
  }

  for (const part of parts.slice(1, -1)) {
    if (!part) {
      continue;
    }
    const index = value.indexOf(part, cursor);
    if (index === -1 || index + part.length > endBound) {
      return false;
    }
    cursor = index + part.length;
  }
  return true;
}

/** Match include/exclude patterns against every supported name for one MCP tool. */
export function isMcpToolAllowedByFilter(params: {
  include?: readonly string[];
  exclude?: readonly string[];
  candidateNames: readonly string[];
}): boolean {
  const matchesAny = (patterns: readonly string[]): boolean =>
    patterns.some((pattern) =>
      params.candidateNames.some((name) => matchesMcpToolFilterPattern(pattern, name)),
    );
  const include = params.include ?? [];
  if (include.length > 0 && !matchesAny(include)) {
    return false;
  }
  return !matchesAny(params.exclude ?? []);
}

/** Return whether any pattern matches any supported name for an MCP tool. */
export function matchesAnyMcpToolFilterCandidate(
  patterns: readonly string[],
  candidateNames: readonly string[],
): boolean {
  return patterns.some((pattern) =>
    candidateNames.some((name) => matchesMcpToolFilterPattern(pattern, name)),
  );
}
