/** Sanitizes MCP server/tool names into stable model-facing tool ids. */
import {
  normalizeLowercaseStringOrEmpty,
  normalizeOptionalLowercaseString,
} from "@openclaw/normalization-core/string-coerce";

// Name sanitizers for tools exposed by bundle MCP servers. Provider/tool names
// must fit model-facing schema limits while remaining stable and collision-free.
const TOOL_NAME_SAFE_RE = /[^A-Za-z0-9_-]/g;
export const TOOL_NAME_SEPARATOR = "__";
const TOOL_NAME_MAX_PREFIX = 30;
const TOOL_NAME_MAX_TOTAL = 64;

function sanitizeToolFragment(raw: string, fallback: string, maxChars?: number): string {
  const cleaned = raw.trim().replace(TOOL_NAME_SAFE_RE, "-");
  const normalized = cleaned || fallback;
  const providerSafe = /^[A-Za-z]/.test(normalized) ? normalized : `${fallback}-${normalized}`;
  if (!maxChars) {
    return providerSafe;
  }
  return providerSafe.length > maxChars ? providerSafe.slice(0, maxChars) : providerSafe;
}

/** Sanitize one MCP server name and reserve it in the provided set. */
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

/**
 * Assign safe server names from the full declared set in declaration order,
 * independent of which servers resolve for a requester. Declaration order
 * preserves legacy collision-suffix ownership for existing static configs;
 * sorting here would silently swap safe names between colliding servers.
 */
export function assignSafeServerNames(serverNames: Iterable<string>): Map<string, string> {
  const usedNames = new Set<string>();
  const assignments = new Map<string, string>();
  for (const serverName of serverNames) {
    assignments.set(serverName, sanitizeServerName(serverName, usedNames));
  }
  return assignments;
}

function sanitizeToolName(raw: string): string {
  return sanitizeToolFragment(raw, "tool");
}

/** Normalizes reserved tool names for collision checks. */
export function normalizeReservedToolNames(names?: Iterable<string>): Set<string> {
  return new Set(
    Array.from(names ?? [], (name) => normalizeOptionalLowercaseString(name)).filter(
      (name): name is string => Boolean(name),
    ),
  );
}

/** Build a safe model-facing tool name from server and tool fragments. */
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
    // Keep the suffix inside the total tool-name budget while preserving the
    // server prefix as the namespace boundary.
    const suffix = `-${n}`;
    candidateToolName = `${(truncatedToolName || "tool").slice(0, Math.max(1, maxToolChars - suffix.length))}${suffix}`;
    candidate = `${params.serverName}${TOOL_NAME_SEPARATOR}${candidateToolName}`;
    n += 1;
  }
  return candidate;
}
