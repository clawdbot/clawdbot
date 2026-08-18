import { isRecord } from "@openclaw/normalization-core/record-coerce";
import { compileGlobPatterns, matchesAnyGlobPattern } from "../../../agents/glob-pattern.js";
import { normalizeToolPolicyName } from "../../../agents/tool-policy-shared.js";

type LegacyToolNameMigration = {
  legacyName: string;
  canonicalName: string;
};

export const TASK_SUGGESTION_TOOL_NAME_MIGRATION = {
  legacyName: "spawn_task",
  canonicalName: "suggest_task",
} as const satisfies LegacyToolNameMigration;

export const IMAGE_INSPECTION_TOOL_NAME_MIGRATION = {
  legacyName: "image",
  canonicalName: "view_image",
} as const satisfies LegacyToolNameMigration;

function inspectLegacyToolNameList(value: unknown, migration: LegacyToolNameMigration) {
  if (!Array.isArray(value)) {
    return null;
  }
  const entries = value.filter((entry): entry is string => typeof entry === "string");
  const legacyName = normalizeToolPolicyName(migration.legacyName);
  const patterns = compileGlobPatterns({ raw: entries, normalize: normalizeToolPolicyName });
  const exactLegacy = entries.some((entry) => normalizeToolPolicyName(entry) === legacyName);
  return {
    exactLegacy,
    appendCanonical:
      !exactLegacy &&
      matchesAnyGlobPattern(legacyName, patterns) &&
      !matchesAnyGlobPattern(normalizeToolPolicyName(migration.canonicalName), patterns),
  };
}

export function hasLegacyToolNameList(value: unknown, migration: LegacyToolNameMigration): boolean {
  const state = inspectLegacyToolNameList(value, migration);
  return state?.exactLegacy === true || state?.appendCanonical === true;
}

export function migrateLegacyToolNameList(
  value: unknown,
  migration: LegacyToolNameMigration,
): boolean {
  const state = inspectLegacyToolNameList(value, migration);
  if (!state || !Array.isArray(value)) {
    return false;
  }
  let mutated = false;
  if (state.exactLegacy) {
    const legacyName = normalizeToolPolicyName(migration.legacyName);
    for (const [index, entry] of value.entries()) {
      if (typeof entry === "string" && normalizeToolPolicyName(entry) === legacyName) {
        value[index] = migration.canonicalName;
        mutated = true;
      }
    }
  }
  if (state.appendCanonical) {
    value.push(migration.canonicalName);
    mutated = true;
  }
  return mutated;
}

function isToolPolicyPath(path: readonly string[]): boolean {
  if (path.at(-1) === "tools" || path.includes("toolsBySender")) {
    return true;
  }
  const byProviderIndex = path.lastIndexOf("byProvider");
  return byProviderIndex >= 0 && path.slice(0, byProviderIndex).includes("tools");
}

function visitLegacyToolName(
  value: unknown,
  path: string[],
  migration: LegacyToolNameMigration,
  migrate: boolean,
  matchedPaths: string[],
): void {
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      visitLegacyToolName(entry, [...path, String(index)], migration, migrate, matchedPaths);
    }
    return;
  }
  if (!isRecord(value)) {
    return;
  }

  const listKeys = isToolPolicyPath(path) ? ["allow", "alsoAllow", "deny"] : [];
  if (Object.hasOwn(value, "toolsAllow")) {
    listKeys.push("toolsAllow");
  }
  for (const key of listKeys) {
    const list = value[key];
    if (!hasLegacyToolNameList(list, migration)) {
      continue;
    }
    matchedPaths.push([...path, key].join("."));
    if (migrate) {
      migrateLegacyToolNameList(list, migration);
    }
  }

  for (const [key, entry] of Object.entries(value)) {
    visitLegacyToolName(entry, [...path, key], migration, migrate, matchedPaths);
  }
}

export function findLegacyToolNamePaths(
  value: unknown,
  migration: LegacyToolNameMigration,
  path: string[] = [],
): string[] {
  const matchedPaths: string[] = [];
  visitLegacyToolName(value, path, migration, false, matchedPaths);
  return matchedPaths;
}

export function migrateLegacyToolNamePolicies(
  value: unknown,
  migration: LegacyToolNameMigration,
  path: string[] = [],
): string[] {
  const matchedPaths: string[] = [];
  visitLegacyToolName(value, path, migration, true, matchedPaths);
  return matchedPaths;
}
