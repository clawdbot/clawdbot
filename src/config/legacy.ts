import { collectChannelLegacyConfigRules } from "../channels/plugins/legacy-config.js";
import { LEGACY_CONFIG_RULES } from "./legacy.rules.js";
import type { LegacyConfigRule } from "./legacy.shared.js";
import type { LegacyConfigIssue } from "./types.js";

function getPathValue(root: Record<string, unknown>, path: string[]): unknown {
  let cursor: unknown = root;
  for (const key of path) {
    if (!cursor || typeof cursor !== "object") {
      return undefined;
    }
    cursor = (cursor as Record<string, unknown>)[key];
  }
  return cursor;
}

function collectExplicitRuleOwnedChannelIds(
  extraRules: readonly LegacyConfigRule[],
): ReadonlySet<string> | undefined {
  const channelIds = new Set<string>();
  for (const rule of extraRules) {
    const [first, second] = rule.path;
    if (first !== "channels" || typeof second !== "string" || second === "defaults") {
      continue;
    }
    channelIds.add(second);
  }
  return channelIds.size > 0 ? channelIds : undefined;
}

export function findLegacyConfigIssues(
  raw: unknown,
  sourceRaw?: unknown,
  extraRules: LegacyConfigRule[] = [],
  touchedPaths?: ReadonlyArray<ReadonlyArray<string>>,
): LegacyConfigIssue[] {
  if (!raw || typeof raw !== "object") {
    return [];
  }
  const root = raw as Record<string, unknown>;
  const sourceRoot =
    sourceRaw && typeof sourceRaw === "object" ? (sourceRaw as Record<string, unknown>) : root;
  const issues: LegacyConfigIssue[] = [];
  const explicitRuleOwnedChannelIds = collectExplicitRuleOwnedChannelIds(extraRules);
  for (const rule of [
    ...LEGACY_CONFIG_RULES,
    ...collectChannelLegacyConfigRules(raw, touchedPaths, explicitRuleOwnedChannelIds),
    ...extraRules,
  ]) {
    const cursor = getPathValue(root, rule.path);
    if (cursor !== undefined && (!rule.match || rule.match(cursor, root))) {
      if (rule.requireSourceLiteral) {
        const sourceCursor = getPathValue(sourceRoot, rule.path);
        if (sourceCursor === undefined) {
          continue;
        }
        if (rule.match && !rule.match(sourceCursor, sourceRoot)) {
          continue;
        }
      }
      issues.push({ path: rule.path.join("."), message: rule.message });
    }
  }
  return issues;
}
