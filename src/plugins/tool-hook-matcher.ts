import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import type { PluginToolMatcher } from "./hook-types.js";

export type PluginToolMatcherScope = {
  matchAll: boolean;
  toolNames: readonly string[];
};

// Reject known non-canonical spellings here without translating them.
// Provider adapters own alias projection in both directions.
const NON_CANONICAL_TOOL_MATCHER_NAMES = new Set([
  "bash",
  "exec_command",
  "apply-patch",
  "write",
  "edit",
  "agent",
]);

/** Omission is the only match-all form; explicit matcher values must stay bounded. */
export function normalizePluginToolMatcher(matcher: unknown): PluginToolMatcher | undefined {
  if (matcher === undefined) {
    return undefined;
  }
  if (!Array.isArray(matcher)) {
    throw new TypeError("tool hook matcher must be an array of tool names");
  }
  if (matcher.length === 0) {
    throw new TypeError("tool hook matcher must contain at least one tool name");
  }
  const normalized = new Set<string>();
  for (let index = 0; index < matcher.length; index += 1) {
    if (!Object.hasOwn(matcher, index)) {
      throw new TypeError("tool hook matcher entries must be non-empty strings");
    }
    const toolName = matcher[index];
    if (typeof toolName !== "string") {
      throw new TypeError("tool hook matcher entries must be non-empty strings");
    }
    const canonicalToolName = normalizeLowercaseStringOrEmpty(toolName);
    if (!canonicalToolName) {
      throw new TypeError("tool hook matcher entries must be non-empty strings");
    }
    if (canonicalToolName === "*") {
      throw new TypeError("tool hook matcher wildcard entries are not supported");
    }
    if (NON_CANONICAL_TOOL_MATCHER_NAMES.has(canonicalToolName)) {
      throw new TypeError("tool hook matcher entries must use canonical OpenClaw tool ids");
    }
    normalized.add(canonicalToolName);
  }
  const toolNames = Array.from(normalized).toSorted();
  if (toolNames.length === 0) {
    throw new TypeError("tool hook matcher entries must be non-empty strings");
  }
  const [firstToolName, ...remainingToolNames] = toolNames;
  if (!firstToolName) {
    throw new TypeError("tool hook matcher entries must be non-empty strings");
  }
  return [firstToolName, ...remainingToolNames];
}

export function pluginToolMatcherCoversTool(matcher: unknown, toolName: string): boolean {
  const normalizedMatcher = normalizePluginToolMatcher(matcher);
  return (
    normalizedMatcher === undefined ||
    normalizedMatcher.includes(normalizeLowercaseStringOrEmpty(toolName))
  );
}

export function createPluginToolMatcherScope(
  matchers: Iterable<unknown>,
): PluginToolMatcherScope | undefined {
  let hasRegistration = false;
  const toolNames = new Set<string>();
  for (const matcher of matchers) {
    hasRegistration = true;
    const normalized = normalizePluginToolMatcher(matcher);
    if (!normalized) {
      return { matchAll: true, toolNames: [] };
    }
    for (const toolName of normalized) {
      toolNames.add(toolName);
    }
  }
  return hasRegistration
    ? { matchAll: false, toolNames: Array.from(toolNames).toSorted() }
    : undefined;
}

export function mergePluginToolMatcherScopes(
  scopes: Iterable<PluginToolMatcherScope | undefined>,
): PluginToolMatcherScope | undefined {
  let hasScope = false;
  const toolNames = new Set<string>();
  for (const scope of scopes) {
    if (!scope) {
      continue;
    }
    hasScope = true;
    if (scope.matchAll) {
      return { matchAll: true, toolNames: [] };
    }
    for (const toolName of scope.toolNames) {
      toolNames.add(toolName);
    }
  }
  return hasScope ? { matchAll: false, toolNames: Array.from(toolNames).toSorted() } : undefined;
}
