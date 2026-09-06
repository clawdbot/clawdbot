import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { filterStringEntries } from "@openclaw/normalization-core/string-normalization";
import type { McpServerToolFilterConfig } from "../config/types.mcp.js";

/** Match the documented MCP tool-filter glob syntax: exact text plus `*`. */
function matchesMcpToolFilterPattern(pattern: string, value: string): boolean {
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
  if (first && !value.startsWith(first)) {
    return false;
  }
  let cursor = first.length;
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

/** Normalizes open-world MCP tool filters into the runtime policy shape. */
export function normalizeMcpToolFilter(raw: unknown): McpServerToolFilterConfig | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  const include = filterStringEntries(raw.include);
  const exclude = filterStringEntries(raw.exclude);
  if (include.length === 0 && exclude.length === 0) {
    return undefined;
  }
  return {
    ...(include.length > 0 ? { include } : {}),
    ...(exclude.length > 0 ? { exclude } : {}),
  };
}

/** Applies the shared include-then-exclude policy. */
export function isMcpToolAllowed(
  toolFilter: McpServerToolFilterConfig | undefined,
  toolName: string,
): boolean {
  const matches = (pattern: string) => matchesMcpToolFilterPattern(pattern, toolName);
  return (
    (!toolFilter?.include?.length || toolFilter.include.some(matches)) &&
    !toolFilter?.exclude?.some(matches)
  );
}
