import {
  defineLegacyConfigMigration,
  ensureRecord,
  getRecord,
  mergeMissing,
  type LegacyConfigMigrationSpec,
  type LegacyConfigRule,
} from "../../../config/legacy.shared.js";
import { normalizeConfiguredMemoryExtraPaths } from "../../../memory-host-sdk/host/config-utils.js";
import type { MemoryExtraPath } from "../../../memory-host-sdk/host/types.js";
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
  const existingPaths = normalizeConfiguredMemoryExtraPaths(
    Array.isArray(search.extraPaths)
      ? search.extraPaths.filter(
          (entry): entry is MemoryExtraPath =>
            typeof entry === "string" || typeof getRecord(entry)?.path === "string",
        )
      : [],
  );
  const nextPaths: MemoryExtraPath[] = [...existingPaths];
  const entryKey = (entry: MemoryExtraPath) =>
    typeof entry === "string" ? `${entry}\0` : `${entry.path}\0${entry.pattern?.trim() ?? ""}`;
  const seen = new Set(existingPaths.map(entryKey));
  let added = 0;
  for (const entry of params.entries) {
    const nextEntry: MemoryExtraPath = entry.pattern ? entry : entry.path;
    const key = entryKey(nextEntry);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    nextPaths.push(nextEntry);
    added += 1;
  }
  if (added > 0) {
    search.extraPaths = nextPaths;
    params.changes.push(
      `Migrated ${added} external QMD path${added === 1 ? "" : "s"} from ${params.sourcePath} → ${params.targetPath}.`,
    );
  }
}

function migrateRetiredQmdSessionIndexing(
  qmd: Record<string, unknown> | null,
  scope: Record<string, unknown>,
  sourcePath: string,
  changes: string[],
  targetPath = sourcePath === "memory.qmd" ? "memory.search" : sourcePath.slice(0, -4),
): void {
  if (getRecord(qmd?.sessions)?.enabled !== true) {
    return;
  }
  const search = ensureRecord(ensureRecord(scope, "memory"), "search");
  const experimental = getRecord(search.experimental);
  let changed = false;
  if (
    (experimental || search.experimental === undefined) &&
    experimental?.sessionMemory === undefined
  ) {
    ensureRecord(search, "experimental").sessionMemory = true;
    changed = true;
  }
  if (
    search.sources === undefined ||
    (Array.isArray(search.sources) && search.sources.length === 0)
  ) {
    search.sources = ["memory", "sessions"];
    changed = true;
  } else if (Array.isArray(search.sources) && !search.sources.includes("sessions")) {
    search.sources.push("sessions");
    changed = true;
  }
  if (changed) {
    changes.push(
      `Migrated ${sourcePath}.sessions.enabled → ${targetPath}.experimental.sessionMemory and ${targetPath}.sources.`,
    );
  }
}

function migrateRetiredMemoryQmd(raw: Record<string, unknown>, changes: string[]): void {
  const memory = getRecord(raw.memory);
  const search = getRecord(memory?.search);
  const qmd = getRecord(memory?.qmd);
  const searchQmd = getRecord(search?.qmd);
  migrateRetiredQmdSessionIndexing(qmd, raw, "memory.qmd", changes);
  migrateRetiredQmdSessionIndexing(searchQmd, raw, "memory.search.qmd", changes);
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
    const isAgentDefaults = scopePath === "agents.defaults" && agentSearch?.qmd !== undefined;
    const targetScope = isAgentDefaults ? raw : scope;
    const targetPath = isAgentDefaults ? "memory.search" : `${scopePath}.memory.search`;
    if (isAgentDefaults && agentSearch) {
      // Agent defaults have no memory owner; global memory.search owns their policy.
      removed = deleteRetiredPath(scope, ["memory", "search", "qmd"]) || removed;
      mergeMissing(ensureRecord(ensureRecord(raw, "memory"), "search"), agentSearch);
      delete scope.memory;
    }
    migrateRetiredQmdSessionIndexing(
      agentSearchQmd,
      targetScope,
      `${scopePath}.memory.search.qmd`,
      changes,
      targetPath,
    );
    migrateRetiredQmdExternalPaths({
      changes,
      entries: readRetiredQmdExternalPaths(agentSearchQmd?.extraCollections),
      scope: targetScope,
      sourcePath: `${scopePath}.memory.search.qmd.extraCollections`,
      targetPath: `${targetPath}.extraPaths`,
    });
    if (!isAgentDefaults) {
      removed = deleteRetiredPath(scope, ["memory", "search", "qmd"]) || removed;
    }
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
        "agents.defaults.memory.search.qmd is retired because the QMD memory backend was removed; configured external collections migrate to memory.search.extraPaths.",
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
