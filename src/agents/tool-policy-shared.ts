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

const TOOL_NAME_ALIASES: Record<string, string> = {
  bash: "exec",
  "apply-patch": "apply_patch",
  // Permanent scheduler-tool alias (owner decision, RFC 0026), like bash -> exec.
  cron: "automations",
};

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

/** Normalizes a tool name or alias to the policy id used for matching. */
/** Refusal for a tool that keeps its schema but sits outside the run's execution allowlist. */
export const TOOL_EXECUTION_GATED_MESSAGE =
  "Unavailable during skill review. Use skill_workshop or finish with NOTHING_TO_LEARN.";

export function isToolExecutionAllowed(allowNames: readonly string[], toolName: string): boolean {
  const target = normalizeToolPolicyName(toolName);
  return allowNames.some((name) => normalizeToolPolicyName(name) === target);
}

export function normalizeToolPolicyName(name: string) {
  const normalized = normalizeLowercaseStringOrEmpty(name);
  return TOOL_NAME_ALIASES[normalized] ?? normalized;
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
    const normalizedToolName = normalizeToolPolicyName(toolName);
    const foldedToolName = normalizeLowercaseStringOrEmpty(toolName);
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

  const resolvedPrefix = normalizeToolPolicyName(normalizedPrefix);
  if (resolvedPrefix !== normalizedPrefix) {
    for (const toolName of allowed) {
      if (toolName.startsWith(resolvedPrefix)) {
        return true;
      }
    }
  }

  for (const [alias, toolName] of Object.entries(TOOL_NAME_ALIASES)) {
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
    const group = TOOL_GROUPS[value];
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
