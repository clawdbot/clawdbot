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
