/**
 * Shared runtime tool policy normalization.
 *
 * Keeps aliases, groups, profile expansion, and prefix matching consistent across allow/deny paths.
 */
import { normalizeLowercaseStringOrEmpty } from "@openclaw/normalization-core/string-coerce";
import { uniqueStrings } from "@openclaw/normalization-core/string-normalization";
import {
  CORE_TOOL_GROUPS,
  resolveCoreToolProfilePolicy,
  type ToolProfileId,
} from "./tool-catalog.js";

type ToolProfilePolicy = {
  allow?: string[];
  deny?: string[];
};

const TOOL_NAME_ALIASES = new Map<string, string>([
  ["bash", "exec"],
  ["apply-patch", "apply_patch"],
  // Permanent scheduler-tool alias (owner decision, RFC 0026), like bash -> exec.
  ["cron", "automations"],
]);

const TOOL_ALLOWLIST_INTERSECTION = Symbol.for("openclaw.toolAllowlistIntersection");
type ToolAllowlistWithIntersection = string[] & {
  [TOOL_ALLOWLIST_INTERSECTION]?: readonly string[][];
};

/** Core tool groups exposed to allow/deny policy config. */
export const TOOL_GROUPS: Record<string, string[]> = { ...CORE_TOOL_GROUPS };

/**
 * Preserves independent allowlists until a concrete tool surface can evaluate
 * them. Intersections of overlapping globs cannot be represented by one glob list.
 */
export function attachToolAllowlistIntersection(
  toolsAllow: string[],
  restrictions: readonly string[][],
): string[] {
  Object.defineProperty(toolsAllow, TOOL_ALLOWLIST_INTERSECTION, {
    configurable: true,
    enumerable: false,
    value: restrictions,
  });
  return toolsAllow;
}

/** Reads independent restrictions attached by a modifying-hook merger. */
export function readToolAllowlistIntersection(
  toolsAllow: string[],
): readonly string[][] | undefined {
  return (toolsAllow as ToolAllowlistWithIntersection)[TOOL_ALLOWLIST_INTERSECTION];
}

/** Refusal for a tool that keeps its schema but sits outside the run's execution allowlist. */
export const TOOL_EXECUTION_GATED_MESSAGE =
  "Unavailable during skill review. Do not retry this tool. Continue with skill_workshop under the review instructions.";

export function isToolExecutionAllowed(allowNames: readonly string[], toolName: string): boolean {
  const target = normalizeToolPolicyName(toolName);
  return allowNames.some((name) => normalizeToolPolicyName(name) === target);
}

/** Snapshot exact names for one synchronous batch; never retain this matcher across awaits. */
export function createToolExecutionMatcher(allowNames: readonly string[]) {
  const allowed = new Set<string>();
  allowNames.forEach((name) => allowed.add(normalizeToolPolicyName(name)));
  return (toolName: string) => allowed.has(normalizeToolPolicyName(toolName));
}

/** Normalizes a tool name or alias to the policy id used for matching. */
export function normalizeToolPolicyName(name: string): string {
  const normalized = normalizeLowercaseStringOrEmpty(name);
  return TOOL_NAME_ALIASES.get(normalized) ?? normalized;
}

/** Checks whether an in-progress prefix can still resolve to an allowed tool or alias. */
export function couldNormalizeToolNamePrefixToAllowedTool(
  prefix: string,
  allowedToolNames: Set<string>,
): boolean {
  const normalizedPrefix = normalizeLowercaseStringOrEmpty(prefix);
  if (!normalizedPrefix) {
    return false;
  }

  const allowed = new Set<string>();
  for (const toolName of allowedToolNames) {
    const foldedToolName = normalizeLowercaseStringOrEmpty(toolName);
    const normalizedToolName = TOOL_NAME_ALIASES.get(foldedToolName) ?? foldedToolName;
    if (normalizedToolName) {
      allowed.add(normalizedToolName);
    }
    if (foldedToolName) {
      allowed.add(foldedToolName);
    }
    if (
      normalizedToolName.startsWith(normalizedPrefix) ||
      foldedToolName.startsWith(normalizedPrefix)
    ) {
      return true;
    }
  }

  const resolvedPrefix = TOOL_NAME_ALIASES.get(normalizedPrefix) ?? normalizedPrefix;
  if (resolvedPrefix !== normalizedPrefix) {
    for (const toolName of allowed) {
      if (toolName.startsWith(resolvedPrefix)) {
        return true;
      }
    }
  }

  for (const [alias, toolName] of TOOL_NAME_ALIASES) {
    if (alias.startsWith(normalizedPrefix) && allowed.has(toolName)) {
      return true;
    }
  }
  return false;
}

/** Normalizes a configured allow/deny list while dropping blank entries. */
export function normalizeToolList(list?: string[]) {
  if (!list) {
    return [];
  }
  return list.map(normalizeToolPolicyName).filter(Boolean);
}

/** Expands named tool groups into concrete tool ids. */
export function expandToolGroups(list?: string[]) {
  const normalized = normalizeToolList(list);
  const expanded: string[] = [];
  for (const value of normalized) {
    const group = Object.hasOwn(TOOL_GROUPS, value) ? TOOL_GROUPS[value] : undefined;
    if (group) {
      expanded.push(...group);
      continue;
    }
    expanded.push(value);
  }
  return uniqueStrings(expanded);
}

/** Resolves a built-in tool profile policy by id. */
export function resolveToolProfilePolicy(profile?: string): ToolProfilePolicy | undefined {
  return resolveCoreToolProfilePolicy(profile);
}

export type { ToolProfileId };
