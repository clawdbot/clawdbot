/**
 * Generated plugin model catalog discovery.
 *
 * The existing agent SQLite cache lets provider discovery reuse plugin-owned
 * catalogs without loading runtimes or creating parallel state files.
 */
import { randomUUID } from "node:crypto";
import { linkSync, readFileSync, readdirSync, renameSync, unlinkSync, type Dirent } from "node:fs";
import path from "node:path";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { executeSqliteQuerySync, getNodeSqliteKysely } from "../infra/kysely-sync.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import { withOpenClawAgentDatabaseReadOnly } from "../state/openclaw-agent-db-readonly.js";
import type { DB as OpenClawAgentKyselyDatabase } from "../state/openclaw-agent-db.generated.js";
import { runOpenClawAgentWriteTransaction } from "../state/openclaw-agent-db.js";
import {
  resolveAuthProfileDatabaseOwnerId,
  resolveAuthProfileDatabasePath,
} from "./auth-profiles/sqlite.js";
import {
  PLUGIN_MODEL_CATALOG_GENERATED_BY,
  repairPluginModelCatalogTransportMetadata,
} from "./plugin-model-catalog-repair.js";

export { PLUGIN_MODEL_CATALOG_GENERATED_BY } from "./plugin-model-catalog-repair.js";

// The in-memory planning key retains the established owner encoding; generated
// payloads themselves are persisted only in the agent SQLite cache.
const PLUGIN_MODEL_CATALOG_FILE = "catalog.json";
const PLUGIN_MODEL_CATALOG_CACHE_SCOPE = "plugin-model-catalog-v1";
const PLUGIN_MODEL_CATALOG_MIGRATION_SCOPE = "plugin-model-catalog-migration-v1";

const log = createSubsystemLogger("agents/plugin-model-catalog");

/** Recognizes canonical catalogs and recoverable atomic migration claims. */
export function isPluginModelCatalogMigrationFile(filename: string): boolean {
  return (
    filename === PLUGIN_MODEL_CATALOG_FILE ||
    filename.startsWith(`${PLUGIN_MODEL_CATALOG_FILE}.doctor-importing-`)
  );
}

type PluginModelCatalogDatabase = Pick<OpenClawAgentKyselyDatabase, "cache_entries">;

type PersistedPluginModelCatalog = {
  pluginId: string;
  contents: string;
};

type PersistedPluginModelCatalogLoadResult = {
  catalogs: PersistedPluginModelCatalog[];
  warnings: string[];
};

function pluginModelCatalogDatabaseOptions(agentDir: string) {
  return {
    agentId: resolveAuthProfileDatabaseOwnerId(agentDir),
    path: resolveAuthProfileDatabasePath(agentDir),
  };
}

function readPersistedPluginModelCatalogEntries(
  agentDir: string,
  scope: string,
): PersistedPluginModelCatalog[] {
  const result = withOpenClawAgentDatabaseReadOnly((database) => {
    const kysely = getNodeSqliteKysely<PluginModelCatalogDatabase>(database.db);
    return executeSqliteQuerySync(
      database.db,
      kysely
        .selectFrom("cache_entries")
        .select(["key", "value_json"])
        .where("scope", "=", scope)
        .orderBy("key"),
    ).rows.flatMap((row) =>
      row.value_json === null ? [] : [{ pluginId: row.key, contents: row.value_json }],
    );
  }, pluginModelCatalogDatabaseOptions(agentDir));
  return result.found ? result.value : [];
}

function readPersistedPluginModelCatalogs(agentDir: string): PersistedPluginModelCatalog[] {
  return readPersistedPluginModelCatalogEntries(agentDir, PLUGIN_MODEL_CATALOG_CACHE_SCOPE);
}

function repairPersistedPluginModelCatalogs(params: {
  agentDir: string;
  catalogs: readonly PersistedPluginModelCatalog[];
}): boolean {
  const repairs = params.catalogs.flatMap((catalog) => {
    const repaired = repairPluginModelCatalogTransportMetadata(catalog.contents);
    return repaired.removedModelCount > 0
      ? [
          {
            ...catalog,
            repairedContents: repaired.contents,
            removedModelCount: repaired.removedModelCount,
          },
        ]
      : [];
  });
  if (repairs.length === 0) {
    return false;
  }

  const updatedAt = Date.now();
  const applied = runOpenClawAgentWriteTransaction(
    (database) => {
      const kysely = getNodeSqliteKysely<PluginModelCatalogDatabase>(database.db);
      return repairs.flatMap((repair) => {
        // Compare-and-set protects a concurrent provider refresh from being
        // overwritten by repair work planned from an older catalog snapshot.
        const result = executeSqliteQuerySync(
          database.db,
          kysely
            .updateTable("cache_entries")
            .set({ value_json: repair.repairedContents, updated_at: updatedAt })
            .where("scope", "=", PLUGIN_MODEL_CATALOG_CACHE_SCOPE)
            .where("key", "=", repair.pluginId)
            .where("value_json", "=", repair.contents),
        );
        return result.numAffectedRows === 1n ? [repair] : [];
      });
    },
    pluginModelCatalogDatabaseOptions(params.agentDir),
    { operationLabel: "plugin-model-catalog.repair" },
  );
  for (const repair of applied) {
    log.warn(
      `Repaired generated model catalog for plugin ${repair.pluginId}: removed ${repair.removedModelCount} model row(s) without provider or model api metadata.`,
    );
  }
  // A concurrent refresh can win the compare-and-set. The caller still needs
  // to reread so this stale pre-transaction snapshot never reaches consumers.
  return true;
}

function readPersistedPluginModelCatalogMigrationPayloads(
  agentDir: string,
): ReadonlyMap<string, string> {
  return new Map(
    readPersistedPluginModelCatalogEntries(agentDir, PLUGIN_MODEL_CATALOG_MIGRATION_SCOPE).map(
      (catalog) => [catalog.pluginId, catalog.contents],
    ),
  );
}

function replacePersistedPluginModelCatalogEntries(params: {
  agentDir: string;
  planned: ReadonlyMap<string, string>;
  migrationPayloads?: ReadonlyMap<string, string>;
  deleteMissing?: boolean;
}): boolean {
  if (
    params.planned.size === 0 &&
    (params.deleteMissing === false ||
      readPersistedPluginModelCatalogs(params.agentDir).length === 0)
  ) {
    return false;
  }
  const updatedAt = Date.now();
  return runOpenClawAgentWriteTransaction(
    (database) => {
      const kysely = getNodeSqliteKysely<PluginModelCatalogDatabase>(database.db);
      const existing = executeSqliteQuerySync(
        database.db,
        kysely
          .selectFrom("cache_entries")
          .select(["key", "value_json"])
          .where("scope", "=", PLUGIN_MODEL_CATALOG_CACHE_SCOPE),
      ).rows;
      const existingByPluginId = new Map(existing.map((row) => [row.key, row.value_json]));
      const existingMigrationPayloads = params.migrationPayloads
        ? new Map(
            executeSqliteQuerySync(
              database.db,
              kysely
                .selectFrom("cache_entries")
                .select(["key", "value_json"])
                .where("scope", "=", PLUGIN_MODEL_CATALOG_MIGRATION_SCOPE),
            ).rows.map((row) => [row.key, row.value_json]),
          )
        : undefined;
      const upsertCacheEntry = (scope: string, pluginId: string, contents: string): void => {
        executeSqliteQuerySync(
          database.db,
          kysely
            .insertInto("cache_entries")
            .values({
              scope,
              key: pluginId,
              value_json: contents,
              blob: null,
              expires_at: null,
              updated_at: updatedAt,
            })
            .onConflict((conflict) =>
              conflict.columns(["scope", "key"]).doUpdateSet({
                value_json: contents,
                blob: null,
                expires_at: null,
                updated_at: updatedAt,
              }),
            ),
        );
      };
      let changed = false;
      for (const [pluginId, contents] of params.planned) {
        const migrationPayload = params.migrationPayloads?.get(pluginId);
        if (migrationPayload && existingMigrationPayloads?.get(pluginId) === migrationPayload) {
          continue;
        }
        if (existingByPluginId.get(pluginId) !== contents) {
          upsertCacheEntry(PLUGIN_MODEL_CATALOG_CACHE_SCOPE, pluginId, contents);
          changed = true;
        }
        if (migrationPayload) {
          upsertCacheEntry(PLUGIN_MODEL_CATALOG_MIGRATION_SCOPE, pluginId, migrationPayload);
          changed = true;
        }
      }
      if (params.deleteMissing !== false) {
        for (const pluginId of existingByPluginId.keys()) {
          if (params.planned.has(pluginId)) {
            continue;
          }
          executeSqliteQuerySync(
            database.db,
            kysely
              .deleteFrom("cache_entries")
              .where("scope", "=", PLUGIN_MODEL_CATALOG_CACHE_SCOPE)
              .where("key", "=", pluginId),
          );
          changed = true;
        }
      }
      return changed;
    },
    pluginModelCatalogDatabaseOptions(params.agentDir),
    {
      operationLabel:
        params.deleteMissing === false
          ? "plugin-model-catalog.migrate"
          : "plugin-model-catalog.replace",
    },
  );
}

type PluginModelCatalogMigrationResult = {
  detected: number;
  migrated: number;
  warnings: string[];
};

function readLegacyPluginModelCatalog(pathname: string): string | null {
  try {
    return readFileSync(pathname, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function hasCommittedExpectedPluginModelCatalogs(
  agentDir: string,
  expectedContents: ReadonlyMap<string, string>,
): boolean {
  const committed = new Map(
    readPersistedPluginModelCatalogs(agentDir).map((catalog) => [
      catalog.pluginId,
      catalog.contents,
    ]),
  );
  const migrationPayloads = readPersistedPluginModelCatalogMigrationPayloads(agentDir);
  for (const [pluginId, contents] of expectedContents) {
    if (committed.get(pluginId) !== contents && migrationPayloads.get(pluginId) !== contents) {
      return false;
    }
  }
  return true;
}

function hasCommittedMigratedPluginModelCatalog(
  agentDir: string,
  pluginId: string,
  contents: string,
): boolean {
  const committed = readPersistedPluginModelCatalogs(agentDir).find(
    (catalog) => catalog.pluginId === pluginId,
  );
  return (
    committed?.contents === contents &&
    readPersistedPluginModelCatalogMigrationPayloads(agentDir).get(pluginId) === contents
  );
}

function retireCommittedPluginModelCatalogMigration(params: {
  agentDir: string;
  pluginId: string;
  contents: string;
}): boolean {
  return runOpenClawAgentWriteTransaction(
    (database) => {
      const kysely = getNodeSqliteKysely<PluginModelCatalogDatabase>(database.db);
      const committed = executeSqliteQuerySync(
        database.db,
        kysely
          .selectFrom("cache_entries")
          .select(["scope", "value_json"])
          .where("key", "=", params.pluginId)
          .where("scope", "in", [
            PLUGIN_MODEL_CATALOG_CACHE_SCOPE,
            PLUGIN_MODEL_CATALOG_MIGRATION_SCOPE,
          ]),
      ).rows;
      const contentsByScope = new Map(committed.map((row) => [row.scope, row.value_json]));
      if (
        contentsByScope.get(PLUGIN_MODEL_CATALOG_CACHE_SCOPE) !== params.contents ||
        contentsByScope.get(PLUGIN_MODEL_CATALOG_MIGRATION_SCOPE) !== params.contents
      ) {
        return false;
      }
      executeSqliteQuerySync(
        database.db,
        kysely
          .deleteFrom("cache_entries")
          .where("scope", "=", PLUGIN_MODEL_CATALOG_MIGRATION_SCOPE)
          .where("key", "=", params.pluginId),
      );
      return true;
    },
    pluginModelCatalogDatabaseOptions(params.agentDir),
    { operationLabel: "plugin-model-catalog.retire-migration" },
  );
}

function retireOrphanedPluginModelCatalogMigrations(params: {
  agentDir: string;
  protectedPluginIds?: ReadonlySet<string>;
}): void {
  for (const [pluginId, contents] of readPersistedPluginModelCatalogMigrationPayloads(
    params.agentDir,
  )) {
    if (params.protectedPluginIds?.has(pluginId)) {
      continue;
    }
    // A crashed claim can leave recovery bytes after its source was removed.
    // The transaction retires them only while the canonical catalog still matches.
    retireCommittedPluginModelCatalogMigration({
      agentDir: params.agentDir,
      pluginId,
      contents,
    });
  }
}

/** Migrates released sidecars before runtime can read or replace agent SQLite state. */
export function migrateLegacyPluginModelCatalogs(params: {
  agentDir: string;
  expectedContents?: ReadonlyMap<string, string>;
  beforeLegacyCatalogClaim?: (pathname: string) => void;
}): PluginModelCatalogMigrationResult {
  const agentDir = path.resolve(params.agentDir);
  const pluginsDir = path.join(agentDir, "plugins");
  const warnings: string[] = [];
  let pluginDirs: Dirent[];
  try {
    pluginDirs = readdirSync(pluginsDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      if (
        params.expectedContents &&
        !hasCommittedExpectedPluginModelCatalogs(agentDir, params.expectedContents)
      ) {
        throw new Error("Could not inspect expected legacy provider catalogs", { cause: error });
      }
      return {
        detected: 0,
        migrated: 0,
        warnings: [`Could not inspect legacy provider catalogs: ${pluginsDir}`],
      };
    }
    if (
      params.expectedContents &&
      params.expectedContents.size > 0 &&
      !hasCommittedExpectedPluginModelCatalogs(agentDir, params.expectedContents)
    ) {
      throw new Error("Legacy provider catalogs disappeared before migration", { cause: error });
    }
    retireOrphanedPluginModelCatalogMigrations({ agentDir });
    return { detected: 0, migrated: 0, warnings: [] };
  }

  const legacyCatalogs: Array<{ pluginId: string; pathname: string; contents: string }> = [];
  const protectedMigrationPluginIds = new Set<string>();
  for (const pluginDir of pluginDirs) {
    if (!pluginDir.isDirectory()) {
      continue;
    }
    const relativePath = path.join("plugins", pluginDir.name, PLUGIN_MODEL_CATALOG_FILE);
    const pluginId = decodePluginModelCatalogRelativePathPluginId(relativePath);
    if (!pluginId) {
      continue;
    }
    const pluginPath = path.join(agentDir, "plugins", pluginDir.name);
    let catalogFiles: Dirent[];
    try {
      catalogFiles = readdirSync(pluginPath, { withFileTypes: true });
    } catch {
      // An uninspected owner may still contain the source for a recovery row.
      // Never retire its credential backup based on an incomplete scan.
      protectedMigrationPluginIds.add(pluginId);
      warnings.push(`Could not inspect legacy provider catalogs: ${pluginPath}`);
      continue;
    }
    const sourceFiles = catalogFiles
      .filter((entry) => entry.isFile() && isPluginModelCatalogMigrationFile(entry.name))
      .toSorted((left, right) => {
        if (left.name === PLUGIN_MODEL_CATALOG_FILE) {
          return 1;
        }
        if (right.name === PLUGIN_MODEL_CATALOG_FILE) {
          return -1;
        }
        return left.name.localeCompare(right.name);
      });
    if (sourceFiles.length > 0) {
      protectedMigrationPluginIds.add(pluginId);
    }
    const pluginLegacyCatalogs: Array<{
      pluginId: string;
      pathname: string;
      contents: string;
    }> = [];
    let hasUnreadableCatalog = false;
    for (const sourceFile of sourceFiles) {
      const pathname = path.join(pluginPath, sourceFile.name);
      let contents: string | null;
      try {
        contents = readLegacyPluginModelCatalog(pathname);
      } catch {
        hasUnreadableCatalog = true;
        warnings.push(`Could not read legacy provider catalog: ${pathname}`);
        continue;
      }
      if (contents === null) {
        warnings.push(`Legacy provider catalog disappeared before migration: ${pathname}`);
        continue;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(contents) as unknown;
      } catch {
        continue;
      }
      if (isGeneratedPluginModelCatalog(parsed)) {
        pluginLegacyCatalogs.push({ pluginId, pathname, contents });
      }
    }
    if (hasUnreadableCatalog) {
      // One inaccessible claim can hold a newer credential than the readable
      // source; migrating either side would make later recovery roll back.
      continue;
    }
    if (
      !pluginLegacyCatalogs.some(
        (catalog) => path.basename(catalog.pathname) === PLUGIN_MODEL_CATALOG_FILE,
      ) &&
      new Set(pluginLegacyCatalogs.map((catalog) => catalog.contents)).size > 1
    ) {
      // Random claim names carry no generation order. Preserve every divergent
      // credential until Doctor or its operator can select an authoritative source.
      warnings.push(`Conflicting retained legacy provider catalogs: ${pluginPath}`);
      continue;
    }
    legacyCatalogs.push(...pluginLegacyCatalogs);
  }

  retireOrphanedPluginModelCatalogMigrations({
    agentDir,
    protectedPluginIds: protectedMigrationPluginIds,
  });

  if (params.expectedContents) {
    const observed = new Map(legacyCatalogs.map((catalog) => [catalog.pluginId, catalog.contents]));
    for (const [pluginId, contents] of params.expectedContents) {
      const observedContents = observed.get(pluginId);
      if (observedContents === contents) {
        continue;
      }
      if (
        observedContents === undefined &&
        hasCommittedExpectedPluginModelCatalogs(agentDir, new Map([[pluginId, contents]]))
      ) {
        continue;
      }
      if (observedContents !== contents) {
        throw new Error(`Legacy provider catalog changed before migration: ${pluginId}`);
      }
    }
  }

  if (legacyCatalogs.length === 0) {
    return { detected: 0, migrated: 0, warnings };
  }

  let migrated = 0;
  for (const catalog of legacyCatalogs) {
    if (
      readPersistedPluginModelCatalogMigrationPayloads(agentDir).get(catalog.pluginId) ===
        catalog.contents &&
      !hasCommittedMigratedPluginModelCatalog(agentDir, catalog.pluginId, catalog.contents)
    ) {
      warnings.push(`Left superseded legacy provider catalog in place: ${catalog.pathname}`);
      continue;
    }
    params.beforeLegacyCatalogClaim?.(catalog.pathname);
    const claimPath = `${catalog.pathname}.doctor-importing-${process.pid}-${randomUUID()}`;
    try {
      // Claim the exact inode before checking or deleting it; a legacy writer
      // can safely recreate catalog.json without losing its newer credentials.
      renameSync(catalog.pathname, claimPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        if (
          hasCommittedExpectedPluginModelCatalogs(
            agentDir,
            new Map([[catalog.pluginId, catalog.contents]]),
          )
        ) {
          migrated += 1;
        } else {
          warnings.push(
            `Legacy provider catalog was claimed before its migration was committed: ${catalog.pathname}`,
          );
        }
      } else {
        try {
          if (readLegacyPluginModelCatalog(catalog.pathname) === catalog.contents) {
            const migrationPayloads = new Map([[catalog.pluginId, catalog.contents]]);
            // A directory can permit reads while forbidding rename. Publish the
            // verified credential, retain its source, and retry cleanup later.
            replacePersistedPluginModelCatalogEntries({
              agentDir,
              planned: migrationPayloads,
              migrationPayloads,
              deleteMissing: false,
            });
          }
        } catch {
          // Preserve the original source and surface its migration warning.
        }
        warnings.push(`Could not remove migrated legacy provider catalog: ${catalog.pathname}`);
      }
      continue;
    }

    try {
      if (readLegacyPluginModelCatalog(claimPath) !== catalog.contents) {
        throw new Error("legacy provider catalog changed before migration could claim it");
      }
      const migrationPayloads = new Map([[catalog.pluginId, catalog.contents]]);
      // Never publish scanned bytes until the exact source inode is claimed.
      // Catalog and temporary credential recovery commit in one transaction.
      replacePersistedPluginModelCatalogEntries({
        agentDir,
        planned: migrationPayloads,
        migrationPayloads,
        deleteMissing: false,
      });
      if (!hasCommittedMigratedPluginModelCatalog(agentDir, catalog.pluginId, catalog.contents)) {
        throw new Error("committed provider catalog changed before migration could remove it");
      }
      unlinkSync(claimPath);
    } catch {
      // linkSync restores without replacing a newer catalog.json created by a
      // concurrent writer; retain the claim if that canonical path already exists.
      let retainedPath = claimPath;
      try {
        linkSync(claimPath, catalog.pathname);
        retainedPath = catalog.pathname;
        unlinkSync(claimPath);
      } catch {
        // Either canonical or claimed bytes remain available for Doctor repair.
      }
      warnings.push(`Left changed legacy provider catalog in place: ${retainedPath}`);
      continue;
    }
    // Retire the temporary secret only when the same SQLite transaction proves
    // the authoritative catalog still contains every migrated credential.
    retireCommittedPluginModelCatalogMigration({
      agentDir,
      pluginId: catalog.pluginId,
      contents: catalog.contents,
    });
    migrated += 1;
  }
  return { detected: legacyCatalogs.length, migrated, warnings };
}

/** Reads available provider catalogs without discarding legacy migration diagnostics. */
export function loadPersistedPluginModelCatalogs(
  agentDir: string,
): PersistedPluginModelCatalogLoadResult {
  const migration = migrateLegacyPluginModelCatalogs({ agentDir });
  let catalogs = readPersistedPluginModelCatalogs(agentDir);
  if (
    migration.warnings.length === 0 &&
    repairPersistedPluginModelCatalogs({ agentDir, catalogs })
  ) {
    catalogs = readPersistedPluginModelCatalogs(agentDir);
  }
  return {
    catalogs,
    warnings: migration.warnings,
  };
}

/** Replaces rebuildable provider catalogs in the existing per-agent SQLite cache. */
export function replacePersistedPluginModelCatalogs(params: {
  agentDir: string;
  pluginCatalogWrites: Readonly<Record<string, string>>;
}): boolean {
  const planned = new Map<string, string>();
  for (const [relativePath, contents] of Object.entries(params.pluginCatalogWrites)) {
    const pluginId = decodePluginModelCatalogRelativePathPluginId(relativePath);
    if (!pluginId) {
      throw new Error(`Invalid generated plugin model catalog key: ${relativePath}`);
    }
    planned.set(pluginId, repairPluginModelCatalogTransportMetadata(contents).contents);
  }
  return replacePersistedPluginModelCatalogEntries({ agentDir: params.agentDir, planned });
}

export type PluginModelCatalogMetadataSnapshot = Pick<PluginMetadataSnapshot, "owners"> & {
  index?: {
    plugins: ReadonlyArray<{
      enabled: boolean;
      pluginId: string;
    }>;
  };
  normalizePluginId?: (pluginId: string) => string;
};

/** Encodes the profile-relative path for a plugin-owned generated model catalog. */
export function encodePluginModelCatalogRelativePath(pluginId: string): string {
  return `plugins/${encodeURIComponent(pluginId)}/${PLUGIN_MODEL_CATALOG_FILE}`;
}

/** Returns true only for canonical profile-relative generated catalog paths. */
function isPluginModelCatalogRelativePath(relativePath: string): boolean {
  const parts = relativePath.split(/[\\/]/);
  return (
    !path.isAbsolute(relativePath) &&
    parts.length === 3 &&
    parts[0] === "plugins" &&
    parts[1] !== "" &&
    parts[1] !== "." &&
    parts[1] !== ".." &&
    parts[2] === PLUGIN_MODEL_CATALOG_FILE
  );
}

/** Decodes the plugin id from a canonical generated catalog path. */
export function decodePluginModelCatalogRelativePathPluginId(
  relativePath: string,
): string | undefined {
  if (!isPluginModelCatalogRelativePath(relativePath)) {
    return undefined;
  }
  const encodedPluginId = relativePath.split(/[\\/]/)[1];
  if (!encodedPluginId) {
    return undefined;
  }
  try {
    return decodeURIComponent(encodedPluginId);
  } catch {
    return undefined;
  }
}

/** Detects model catalogs generated by OpenClaw rather than user-authored JSON. */
export function isGeneratedPluginModelCatalog(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    (value as { generatedBy?: unknown }).generatedBy === PLUGIN_MODEL_CATALOG_GENERATED_BY
  );
}

/** Resolves the sole enabled plugin that owns a provider's model catalog. */
export function resolvePluginModelCatalogOwnerPluginId(params: {
  providerId: string;
  pluginMetadataSnapshot?: PluginModelCatalogMetadataSnapshot;
}): string | undefined {
  const snapshot = params.pluginMetadataSnapshot;
  const owners = snapshot?.owners;
  if (!owners) {
    return undefined;
  }
  const providerId = normalizeProviderId(params.providerId);
  const candidates = [
    owners.modelCatalogProviders.get(providerId),
    owners.providers.get(providerId),
    owners.setupProviders.get(providerId),
  ].find((entry): entry is readonly string[] => Array.isArray(entry) && entry.length > 0);
  const pluginId = candidates?.length === 1 ? candidates[0] : undefined;
  if (!pluginId) {
    return undefined;
  }
  if (!snapshot?.index) {
    return pluginId;
  }
  const normalizedPluginId = snapshot.normalizePluginId?.(pluginId) ?? pluginId;
  return snapshot.index.plugins.some(
    (plugin) => plugin.pluginId === normalizedPluginId && plugin.enabled,
  )
    ? normalizedPluginId
    : undefined;
}

/** Keeps generated catalog providers only when the catalog plugin still owns them. */
export function filterGeneratedPluginModelCatalogProviders<T>(params: {
  catalogPluginId?: string;
  parsedCatalog?: unknown;
  pluginMetadataSnapshot?: PluginModelCatalogMetadataSnapshot;
  providers: Record<string, T>;
}): Record<string, T> {
  if (
    !params.catalogPluginId ||
    !params.pluginMetadataSnapshot ||
    (params.parsedCatalog !== undefined && !isGeneratedPluginModelCatalog(params.parsedCatalog))
  ) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(params.providers).filter(([providerId]) => {
      return (
        resolvePluginModelCatalogOwnerPluginId({
          providerId,
          pluginMetadataSnapshot: params.pluginMetadataSnapshot,
        }) === params.catalogPluginId
      );
    }),
  );
}
