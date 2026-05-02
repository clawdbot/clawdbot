import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "../shared/string-coerce.js";

const TOOL_NAME_SAFE_RE = /[^A-Za-z0-9_-]/g;
export const TOOL_NAME_SEPARATOR = "__";
const TOOL_NAME_MAX_PREFIX = 30;
const TOOL_NAME_MAX_TOTAL = 64;

function sanitizeToolFragment(raw: string, fallback: string, maxChars?: number): string {
  const cleaned = raw.trim().replace(TOOL_NAME_SAFE_RE, "-");
  const normalized = cleaned || fallback;
  if (!maxChars) {
    return normalized;
  }
  return normalized.length > maxChars ? normalized.slice(0, maxChars) : normalized;
}

export function sanitizeServerName(raw: string, usedNames: Set<string>): string {
  const base = sanitizeToolFragment(raw, "mcp", TOOL_NAME_MAX_PREFIX);
  let candidate = base;
  let n = 2;
  while (usedNames.has(normalizeLowercaseStringOrEmpty(candidate))) {
    const suffix = `-${n}`;
    candidate = `${base.slice(0, Math.max(1, TOOL_NAME_MAX_PREFIX - suffix.length))}${suffix}`;
    n += 1;
  }
  usedNames.add(normalizeLowercaseStringOrEmpty(candidate));
  return candidate;
}

function sanitizeToolName(raw: string): string {
  return sanitizeToolFragment(raw, "tool");
}

export function normalizeReservedToolNames(names?: Iterable<string>): Set<string> {
  return new Set(
    Array.from(names ?? [], (name) => normalizeOptionalLowercaseString(name)).filter(
      (name): name is string => Boolean(name),
    ),
  );
}

export function buildSafeToolName(params: {
  serverName: string;
  toolName: string;
  reservedNames: Set<string>;
}): string {
  const cleanedToolName = sanitizeToolName(params.toolName);
  const maxToolChars = Math.max(
    1,
    TOOL_NAME_MAX_TOTAL - params.serverName.length - TOOL_NAME_SEPARATOR.length,
  );
  const truncatedToolName = cleanedToolName.slice(0, maxToolChars);
  let candidateToolName = truncatedToolName || "tool";
  let candidate = `${params.serverName}${TOOL_NAME_SEPARATOR}${candidateToolName}`;
  let n = 2;
  while (params.reservedNames.has(normalizeLowercaseStringOrEmpty(candidate))) {
    const suffix = `-${n}`;
    candidateToolName = `${(truncatedToolName || "tool").slice(0, Math.max(1, maxToolChars - suffix.length))}${suffix}`;
    candidate = `${params.serverName}${TOOL_NAME_SEPARATOR}${candidateToolName}`;
    n += 1;
  }
  return candidate;
}
