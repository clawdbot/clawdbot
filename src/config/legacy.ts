// Applies legacy config rules during load-time compatibility checks.
import { LEGACY_CONFIG_MIGRATION_RULES as LEGACY_CONFIG_RULES } from "../commands/doctor/shared/legacy-config-migrations.js";
import type { LegacyConfigRule } from "./legacy.shared.js";
import type { LegacyConfigIssue } from "./types.js";

/**
 * Missing agents.list means a shipped implicit-main config; explicit [] marks staged new-world setup.
 * Only the absent key takes the automatic upgrade path.
 */
export function migratePersistedImplicitMainRoster(raw: unknown): {
  config: unknown;
  changed: boolean;
  diagnostics: string[];
} {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { config: raw, changed: false, diagnostics: [] };
  }
  const root = raw as Record<string, unknown>;
  if (
    Object.hasOwn(root, "agents") &&
    (!root.agents || typeof root.agents !== "object" || Array.isArray(root.agents))
  ) {
    return { config: raw, changed: false, diagnostics: [] };
  }
  const agents =
    root.agents && typeof root.agents === "object" && !Array.isArray(root.agents)
      ? (root.agents as Record<string, unknown>)
      : {};
  if (!Object.hasOwn(agents, "list")) {
    return {
      config: { ...root, agents: { ...agents, list: [{ id: "main", default: true }] } },
      changed: true,
      diagnostics: [],
    };
  }
  const list = agents.list;
  if (!Array.isArray(list) || list.length === 0) {
    return { config: raw, changed: false, diagnostics: [] };
  }
  const defaultIndexes = list.flatMap((entry, index) =>
    entry && typeof entry === "object" && !Array.isArray(entry) && entry.default === true
      ? [index]
      : [],
  );
  if (defaultIndexes.length === 1) {
    return { config: raw, changed: false, diagnostics: [] };
  }
  const effectiveIndex = defaultIndexes[0] ?? 0;
  const repaired = list.map((entry, index) => {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      return entry;
    }
    const next = Object.assign({}, entry as Record<string, unknown>);
    if (index === effectiveIndex) {
      next.default = true;
    } else {
      delete next.default;
    }
    return next;
  });
  return {
    config: { ...root, agents: { ...agents, list: repaired } },
    changed: true,
    diagnostics: [
      defaultIndexes.length === 0
        ? "Migrated agents.list by marking the first entry as default."
        : `Migrated agents.list by keeping agents.list.${effectiveIndex} as default and clearing ${defaultIndexes.length - 1} duplicate marker(s).`,
    ],
  };
}

// Legacy checks use raw dotted paths so doctor can report exact config keys.
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

/** Finds legacy config issues using built-in rules plus optional caller rules. */
export function findLegacyConfigIssues(
  raw: unknown,
  sourceRaw?: unknown,
  extraRules: LegacyConfigRule[] = [],
  _touchedPaths?: ReadonlyArray<ReadonlyArray<string>>,
): LegacyConfigIssue[] {
  if (!raw || typeof raw !== "object") {
    return [];
  }
  const root = raw as Record<string, unknown>;
  const sourceRoot =
    sourceRaw && typeof sourceRaw === "object" ? (sourceRaw as Record<string, unknown>) : root;
  const issues: LegacyConfigIssue[] = [];
  for (const rule of [...LEGACY_CONFIG_RULES, ...extraRules]) {
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
