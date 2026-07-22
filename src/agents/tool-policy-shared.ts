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

export type ToolProfileDefinition = {
  extends: string;
  alsoAllow?: string[];
  deny?: string[];
};

export type ToolProfileDefinitions = Record<string, ToolProfileDefinition>;

const TOOL_NAME_ALIASES: Record<string, string> = {
  bash: "exec",
  "apply-patch": "apply_patch",
};

/** Core tool groups exposed to allow/deny policy config. */
export const TOOL_GROUPS: Record<string, string[]> = { ...CORE_TOOL_GROUPS };

/** Normalizes a tool name or alias to the policy id used for matching. */
export function normalizeToolName(name: string) {
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
    const normalizedToolName = normalizeToolName(toolName);
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

  const resolvedPrefix = normalizeToolName(normalizedPrefix);
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
  return list.map(normalizeToolName).filter(Boolean);
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

/** Resolves a built-in or configured tool profile policy by id. */
export function resolveToolProfilePolicy(
  profile?: string,
  definitions?: ToolProfileDefinitions,
): ToolProfilePolicy | undefined {
  const corePolicy = resolveCoreToolProfilePolicy(profile);
  if (corePolicy) {
    return corePolicy;
  }
  if (!profile || !definitions) {
    return undefined;
  }

  const chain: ToolProfileDefinition[] = [];
  const seen = new Set<string>();
  let current = profile;
  while (true) {
    if (seen.has(current)) {
      return undefined;
    }
    seen.add(current);
    const definition = Object.hasOwn(definitions, current) ? definitions[current] : undefined;
    if (!definition) {
      return undefined;
    }
    chain.push(definition);
    const parentPolicy = resolveCoreToolProfilePolicy(definition.extends);
    if (parentPolicy) {
      let resolved = parentPolicy;
      for (const entry of chain.toReversed()) {
        const allow = uniqueStrings([...(resolved.allow ?? []), ...(entry.alsoAllow ?? [])]);
        const deny = uniqueStrings([...(resolved.deny ?? []), ...(entry.deny ?? [])]);
        resolved = {
          allow: allow.length > 0 ? allow : undefined,
          deny: deny.length > 0 ? deny : undefined,
        };
      }
      return resolved;
    }
    current = definition.extends;
  }
}

export type { ToolProfileId };
