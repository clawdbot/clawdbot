import { isRecord } from "@openclaw/normalization-core/record-coerce";

export const LEGACY_TASK_SUGGESTION_TOOL_NAME = "spawn_task";
export const TASK_SUGGESTION_TOOL_NAME = "suggest_task";

function isLegacyTaskSuggestionToolName(value: unknown): boolean {
  return (
    typeof value === "string" && value.trim().toLowerCase() === LEGACY_TASK_SUGGESTION_TOOL_NAME
  );
}

export function hasLegacyTaskSuggestionToolList(value: unknown): boolean {
  return Array.isArray(value) && value.some(isLegacyTaskSuggestionToolName);
}

export function migrateLegacyTaskSuggestionToolList(value: unknown): boolean {
  if (!Array.isArray(value)) {
    return false;
  }
  let mutated = false;
  for (const [index, entry] of value.entries()) {
    if (isLegacyTaskSuggestionToolName(entry)) {
      value[index] = TASK_SUGGESTION_TOOL_NAME;
      mutated = true;
    }
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

function visitLegacyTaskSuggestionToolNames(
  value: unknown,
  path: string[],
  migrate: boolean,
  matchedPaths: string[],
): void {
  if (Array.isArray(value)) {
    for (const [index, entry] of value.entries()) {
      visitLegacyTaskSuggestionToolNames(entry, [...path, String(index)], migrate, matchedPaths);
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
    if (!Array.isArray(list) || !list.some(isLegacyTaskSuggestionToolName)) {
      continue;
    }
    matchedPaths.push([...path, key].join("."));
    if (migrate) {
      migrateLegacyTaskSuggestionToolList(list);
    }
  }

  for (const [key, entry] of Object.entries(value)) {
    visitLegacyTaskSuggestionToolNames(entry, [...path, key], migrate, matchedPaths);
  }
}

export function findLegacyTaskSuggestionToolPaths(value: unknown, path: string[] = []): string[] {
  const matchedPaths: string[] = [];
  visitLegacyTaskSuggestionToolNames(value, path, false, matchedPaths);
  return matchedPaths;
}

export function migrateLegacyTaskSuggestionToolPolicies(
  value: unknown,
  path: string[] = [],
): string[] {
  const matchedPaths: string[] = [];
  visitLegacyTaskSuggestionToolNames(value, path, true, matchedPaths);
  return matchedPaths;
}
