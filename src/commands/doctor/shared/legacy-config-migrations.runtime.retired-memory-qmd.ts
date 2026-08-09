import {
  defineLegacyConfigMigration,
  ensureRecord,
  getRecord,
  type LegacyConfigMigrationSpec,
  type LegacyConfigRule,
} from "../../../config/legacy.shared.js";
import { visitAgentConfigScopes } from "./legacy-config-migrations.runtime.tier-eval.js";
import { deleteRetiredPath } from "./legacy-config-record-shared.js";

const rule = (
  path: string[],
  message: string,
  match?: LegacyConfigRule["match"],
): LegacyConfigRule => ({
  path,
  message: `${message} Run "openclaw doctor --fix".`,
  ...(match ? { match } : {}),
});

function hasRetiredAgentMemoryQmd(value: unknown): boolean {
  const memory = getRecord(getRecord(value)?.memory);
  const search = getRecord(memory?.search);
  return Boolean(search && Object.hasOwn(search, "qmd"));
}

type RetiredQmdExternalPath = {
  path: string;
  pattern?: string;
};

function readRetiredQmdExternalPaths(value: unknown): RetiredQmdExternalPath[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const paths: RetiredQmdExternalPath[] = [];
  for (const candidate of value) {
    const entry = getRecord(candidate);
    const path = typeof entry?.path === "string" ? entry.path.trim() : "";
    if (!path) {
      continue;
    }
    const pattern = typeof entry?.pattern === "string" ? entry.pattern.trim() : "";
    paths.push({ path, ...(pattern ? { pattern } : {}) });
  }
  return paths;
}

function migrateRetiredQmdExternalPaths(params: {
  changes: string[];
  entries: RetiredQmdExternalPath[];
  scope: Record<string, unknown>;
  sourcePath: string;
  targetPath: string;
}): void {
  if (params.entries.length === 0) {
    return;
  }
  const memory = ensureRecord(params.scope, "memory");
  const search = ensureRecord(memory, "search");
  const existingPaths = Array.isArray(search.extraPaths)
    ? search.extraPaths.filter((value): value is string => typeof value === "string")
    : [];
  const nextPaths = [...existingPaths];
  const seen = new Set(existingPaths.map((value) => value.trim()).filter(Boolean));
  let added = 0;
  let unsupportedPatterns = 0;
  for (const entry of params.entries) {
    if (!seen.has(entry.path)) {
      seen.add(entry.path);
      nextPaths.push(entry.path);
      added += 1;
    }
    if (entry.pattern && entry.pattern !== "**/*.md") {
      unsupportedPatterns += 1;
    }
  }
  if (added > 0) {
    search.extraPaths = nextPaths;
    params.changes.push(
      `Migrated ${added} external QMD path${added === 1 ? "" : "s"} from ${params.sourcePath} → ${params.targetPath}.`,
    );
  }
  if (unsupportedPatterns > 0) {
    params.changes.push(
      `Removed ${unsupportedPatterns} QMD path pattern filter${unsupportedPatterns === 1 ? "" : "s"} from ${params.sourcePath}; builtin memory indexes supported files under the preserved paths.`,
    );
  }
}

function migrateRetiredMemoryQmd(raw: Record<string, unknown>, changes: string[]): void {
  const memory = getRecord(raw.memory);
  const search = getRecord(memory?.search);
  const qmd = getRecord(memory?.qmd);
  const searchQmd = getRecord(search?.qmd);
  migrateRetiredQmdExternalPaths({
    changes,
    entries: [
      ...readRetiredQmdExternalPaths(qmd?.paths),
      ...readRetiredQmdExternalPaths(searchQmd?.extraCollections),
    ],
    scope: raw,
    sourcePath: "memory.qmd.paths and memory.search.qmd.extraCollections",
    targetPath: "memory.search.extraPaths",
  });
  let removed = false;
  for (const path of [
    ["memory", "backend"],
    ["memory", "qmd"],
    ["memory", "search", "qmd"],
  ] as const) {
    removed = deleteRetiredPath(raw, path) || removed;
  }
  visitAgentConfigScopes(raw, (scope, scopePath) => {
    const agentSearch = getRecord(getRecord(scope.memory)?.search);
    const agentSearchQmd = getRecord(agentSearch?.qmd);
    migrateRetiredQmdExternalPaths({
      changes,
      entries: readRetiredQmdExternalPaths(agentSearchQmd?.extraCollections),
      scope,
      sourcePath: `${scopePath}.memory.search.qmd.extraCollections`,
      targetPath: `${scopePath}.memory.search.extraPaths`,
    });
    removed = deleteRetiredPath(scope, ["memory", "search", "qmd"]) || removed;
  });
  if (removed) {
    changes.push(
      "Removed retired QMD memory configuration; builtin memory is now the only memory engine.",
    );
  }
}

export const LEGACY_CONFIG_MIGRATION_RUNTIME_MEMORY_QMD: LegacyConfigMigrationSpec =
  defineLegacyConfigMigration({
    id: "runtime.memory-qmd-retired",
    describe: "Remove retired QMD memory configuration",
    legacyRules: [
      rule(
        ["memory", "backend"],
        "memory.backend is retired; builtin memory is now the only memory engine.",
      ),
      rule(
        ["memory", "qmd"],
        "memory.qmd is retired because the QMD memory backend was removed; configured external paths migrate to memory.search.extraPaths.",
      ),
      rule(
        ["memory", "search", "qmd"],
        "memory.search.qmd is retired because the QMD memory backend was removed; configured external collections migrate to memory.search.extraPaths.",
      ),
      rule(
        ["agents", "defaults", "memory", "search", "qmd"],
        "agents.defaults.memory.search.qmd is retired because the QMD memory backend was removed; configured external collections migrate to agents.defaults.memory.search.extraPaths.",
      ),
      rule(
        ["agents", "entries"],
        "agents.entries.*.memory.search.qmd is retired because the QMD memory backend was removed; configured external collections migrate to the matching agent memory.search.extraPaths.",
        (value) => {
          const entries = getRecord(value);
          return entries ? Object.values(entries).some(hasRetiredAgentMemoryQmd) : false;
        },
      ),
      rule(
        ["agents", "list"],
        "agents.list.*.memory.search.qmd is retired because the QMD memory backend was removed; configured external collections migrate to the matching agent memory.search.extraPaths.",
        (value) => Array.isArray(value) && value.some(hasRetiredAgentMemoryQmd),
      ),
    ],
    apply: migrateRetiredMemoryQmd,
  });
