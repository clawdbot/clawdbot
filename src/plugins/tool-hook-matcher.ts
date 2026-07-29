import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";

type PluginToolMatcher = readonly string[] | undefined;

export type PluginToolMatcherScope = {
  matchAll: boolean;
  toolNames: readonly string[];
};

const TOOL_ALIAS_GROUPS = [
  {
    canonical: "exec",
    nativeNames: ["Bash", "exec", "exec_command"],
  },
  {
    canonical: "apply_patch",
    nativeNames: ["apply_patch", "Write", "Edit"],
  },
] as const;

const CANONICAL_TOOL_NAME_BY_ALIAS = new Map<string, string>();
const NATIVE_TOOL_NAMES_BY_CANONICAL = new Map<string, readonly string[]>();

for (const group of TOOL_ALIAS_GROUPS) {
  NATIVE_TOOL_NAMES_BY_CANONICAL.set(group.canonical, group.nativeNames);
  for (const alias of group.nativeNames) {
    CANONICAL_TOOL_NAME_BY_ALIAS.set(normalizeLowercaseStringOrEmpty(alias), group.canonical);
  }
}
CANONICAL_TOOL_NAME_BY_ALIAS.set("apply-patch", "apply_patch");

/** Canonicalizes OpenClaw and Codex spellings through one shared alias model. */
export function normalizePluginToolName(toolName: string): string {
  const normalized = normalizeLowercaseStringOrEmpty(toolName);
  return CANONICAL_TOOL_NAME_BY_ALIAS.get(normalized) ?? normalized;
}

/** Omitted and empty matchers preserve the existing match-all registration contract. */
export function normalizePluginToolMatcher(matcher: PluginToolMatcher): string[] | undefined {
  if (matcher === undefined) {
    return undefined;
  }
  if (!Array.isArray(matcher)) {
    throw new TypeError("tool hook matcher must be an array of tool names");
  }
  const entries = Array.from(matcher);
  if (
    entries.some(
      (toolName) =>
        typeof toolName !== "string" || normalizeLowercaseStringOrEmpty(toolName).length === 0,
    )
  ) {
    throw new TypeError("tool hook matcher entries must be non-empty strings");
  }
  const normalized = Array.from(
    new Set(entries.map((toolName) => normalizePluginToolName(toolName))),
  ).toSorted();
  if (normalized.includes("*")) {
    return undefined;
  }
  return normalized.length > 0 ? normalized : undefined;
}

export function pluginToolMatcherCoversTool(matcher: PluginToolMatcher, toolName: string): boolean {
  const normalizedMatcher = normalizePluginToolMatcher(matcher);
  return (
    normalizedMatcher === undefined || normalizedMatcher.includes(normalizePluginToolName(toolName))
  );
}

export function createPluginToolMatcherScope(
  matchers: Iterable<PluginToolMatcher>,
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

/** Converts a local scope to a bounded exact or anchored Codex matcher. */
export function buildCodexNativeToolMatcher(
  scope: PluginToolMatcherScope | undefined,
): string | undefined {
  if (!scope || scope.matchAll) {
    return undefined;
  }
  const nativeNames = new Set<string>();
  let hasCustomToolName = false;
  for (const toolName of scope.toolNames) {
    const aliases = NATIVE_TOOL_NAMES_BY_CANONICAL.get(toolName);
    if (!aliases) {
      hasCustomToolName = true;
    }
    for (const alias of aliases ?? [toolName]) {
      nativeNames.add(alias);
    }
  }
  if (nativeNames.size === 0) {
    return undefined;
  }
  const sortedNames = Array.from(nativeNames).toSorted();
  if (!hasCustomToolName && sortedNames.every((toolName) => /^[A-Za-z0-9_]+$/.test(toolName))) {
    return sortedNames.join("|");
  }
  const escapedNames = sortedNames.map((toolName) =>
    toolName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
  );
  return `(?i)^(?:${escapedNames.join("|")})$`;
}
