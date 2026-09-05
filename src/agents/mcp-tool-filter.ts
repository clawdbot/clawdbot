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

/** A tool filter glob that matches every name: an all-`*` pattern. */
function isMatchAllToolFilterPattern(pattern: string): boolean {
  const trimmed = pattern.trim();
  return trimmed.length > 0 && /^\*+$/.test(trimmed);
}

/**
 * Whether a failed server's tool filter could still expose a tool when its raw
 * tool names are unknown after a failed catalog load. `include` alone always
 * leaves a matchable name, so only an `exclude` that matches every name — an
 * all-`*` glob — hides the whole surface, and it dominates any `include`. A
 * self-canceling `include`/`exclude` pair is not a shipped filter shape; it is
 * treated as exposing, matching the healthy path's per-name decision. Guards
 * outage disclosure: a fully excluded server must not leak its name and error.
 */
export function mcpToolFilterCouldExposeTool(
  toolFilter: McpServerToolFilterConfig | undefined,
): boolean {
  return !(toolFilter?.exclude?.some(isMatchAllToolFilterPattern) ?? false);
}
