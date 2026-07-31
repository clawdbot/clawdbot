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
  ambiguousIncludePatterns?: ReadonlySet<string>;
}): boolean {
  const matchesAny = (patterns: readonly string[], skipAmbiguousExact: boolean): boolean =>
    patterns.some((pattern) => {
      const trimmed = pattern.trim();
      if (
        skipAmbiguousExact &&
        !trimmed.includes("*") &&
        params.ambiguousIncludePatterns?.has(trimmed)
      ) {
        return false;
      }
      return params.candidateNames.some((name) => matchesMcpToolFilterPattern(pattern, name));
    });
  const include = params.include ?? [];
  if (include.length > 0 && !matchesAny(include, true)) {
    return false;
  }
  return !matchesAny(params.exclude ?? [], false);
}

/** Find exact include patterns that identify more than one advertised MCP tool. */
export function findAmbiguousExactMcpToolFilterPatterns(params: {
  patterns: readonly string[];
  candidateGroups: readonly (readonly string[])[];
}): Set<string> {
  const ambiguous = new Set<string>();
  for (const pattern of params.patterns) {
    const trimmed = pattern.trim();
    if (!trimmed || trimmed.includes("*")) {
      continue;
    }
    let matchingGroups = 0;
    for (const candidateNames of params.candidateGroups) {
      if (candidateNames.some((name) => matchesMcpToolFilterPattern(trimmed, name))) {
        matchingGroups += 1;
        if (matchingGroups > 1) {
          ambiguous.add(trimmed);
          break;
        }
      }
    }
  }
  return ambiguous;
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
