// Snapshots every SQLite database owned by the frozen backup resource inventory.
import type { Dirent, Stats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import type { BackupResourceInventory } from "../commands/backup-resource-inventory.js";
import { isPathWithin } from "../commands/cleanup-utils.js";
import { resolveGatewayLockDir } from "../config/paths.js";
import { normalizeAgentId } from "../routing/session-key.js";
import { assertOpenClawAgentDatabaseOwner } from "../state/openclaw-agent-db-maintenance.js";
import { assertOpenClawStateDatabaseOwner } from "../state/openclaw-state-db-maintenance.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import {
  sanitizeOpenClawGlobalStateSnapshot,
  sanitizeOpenClawStateLeaseRows,
} from "../state/openclaw-state-snapshot-sanitizer.js";
import { isTransientSqliteBackupPath } from "./backup-volatile-filter.js";
import { hasErrnoCode } from "./errno.js";
import { collectErrorGraphCandidates, formatErrorMessage } from "./errors.js";
import { sameFileIdentity } from "./fs-safe-advanced.js";
import { resolveSqliteDatabaseFilePaths, SQLITE_SIDECAR_SUFFIXES } from "./sqlite-files.js";
import { createVerifiedSqliteSnapshot } from "./sqlite-snapshot.js";
import {
  createLegacyAuditDatabaseWitness,
  LegacyAuditBackupStateChangedError,
  rewriteLegacyAuditBackupCheckpoints,
  type LegacyAuditBackupSnapshot,
} from "./state-migrations.audit-backup.js";

type SqliteBackupAsset = {
  sourcePath: string;
  archiveSourcePath: string;
  skippedSourcePaths: Set<string>;
};

function findLegacyAuditBackupStateChange(
  error: unknown,
): LegacyAuditBackupStateChangedError | undefined {
  return collectErrorGraphCandidates(error, (candidate) =>
    candidate instanceof Error ? [candidate.cause] : [],
  ).find(
    (candidate): candidate is LegacyAuditBackupStateChangedError =>
      candidate instanceof LegacyAuditBackupStateChangedError,
  );
}

type CanonicalSqliteSource = {
  archiveSourcePath: string;
  identity: Stats;
  sourcePath: string;
} & ({ role: "global" } | { role: "agent"; agentId: string });

function resolveBackupAgentDatabaseOwner(
  sourcePath: string,
  inventory: BackupResourceInventory,
): string | undefined {
  const resolvedSourcePath = path.resolve(sourcePath);
  if (path.basename(resolvedSourcePath) !== "openclaw-agent.sqlite") {
    return undefined;
  }

  const stateSegments = path.relative(inventory.stateDir, resolvedSourcePath).split(path.sep);
  const defaultLayoutAgentId =
    stateSegments.length === 4 && stateSegments[0] === "agents" && stateSegments[2] === "agent"
      ? stateSegments[1]
      : undefined;
  // Case-insensitive filesystems can resolve a configured `main` root to an
  // on-disk `Main` directory; physical owner spelling still must fail closed.
  if (defaultLayoutAgentId && normalizeAgentId(defaultLayoutAgentId) !== defaultLayoutAgentId) {
    throw new Error(
      `Canonical agent SQLite path has a noncanonical agent owner ${defaultLayoutAgentId}: ${resolvedSourcePath}`,
    );
  }

  const declaredOwners = inventory.agentRoots.filter(
    ({ databasePath }) => path.resolve(databasePath) === resolvedSourcePath,
  );
  if (declaredOwners.length > 1) {
    const distinctAgentIds = new Set(declaredOwners.map(({ agentId }) => agentId));
    if (distinctAgentIds.size > 1) {
      throw new Error(
        `Canonical agent SQLite path has multiple configured owners (${[...distinctAgentIds].join(", ")}): ${resolvedSourcePath}`,
      );
    }
  }
  const configuredAgentId = declaredOwners[0]?.agentId;
  if (configuredAgentId) {
    return configuredAgentId;
  }

  // Older state trees can contain agents absent from the current config. Their
  // shipped canonical layout still identifies the owner without a DB registry.
  return defaultLayoutAgentId;
}

function resolveSqliteBackupDatabasePath(sourcePath: string): string | undefined {
  for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
    if (sourcePath.endsWith(suffix)) {
      const databasePath = sourcePath.slice(0, -suffix.length);
      return databasePath.endsWith(".sqlite") ? databasePath : undefined;
    }
  }
  return sourcePath.endsWith(".sqlite") ? sourcePath : undefined;
}

export function classifyBackupSqliteSource(
  sourcePath: string,
  inventory: BackupResourceInventory,
): "excluded" | "sqlite" | undefined {
  const resolvedSourcePath = path.resolve(sourcePath);
  const transient = isTransientSqliteBackupPath(resolvedSourcePath);
  const databasePath = resolveSqliteBackupDatabasePath(resolvedSourcePath);
  if (!transient && !databasePath) {
    return undefined;
  }
  const withinOwnedRoot =
    isPathWithin(resolvedSourcePath, inventory.stateDir) ||
    inventory.agentRoots.some(({ sourcePath: agentRoot }) =>
      isPathWithin(resolvedSourcePath, agentRoot),
    );
  if (!withinOwnedRoot || inventory.isPackageContent(resolvedSourcePath)) {
    return undefined;
  }
  if (transient) {
    return "excluded";
  }
  return inventory.isIncluded(resolvedSourcePath) ? "sqlite" : "excluded";
}

async function discoverBackupSqliteSources(params: {
  inventory: BackupResourceInventory;
  globalStateSqlitePath: string;
}): Promise<{ snapshotPaths: string[]; discoveredSourcePaths: Set<string> }> {
  const snapshotPaths = new Set<string>();
  const discoveredSourcePaths = new Set<string>();
  const visitedDirectories = new Set<string>();
  const gatewayLockDir = resolveGatewayLockDir(params.inventory.stateDir);

  async function visit(directoryPath: string): Promise<void> {
    const resolvedDirectoryPath = path.resolve(directoryPath);
    if (visitedDirectories.has(resolvedDirectoryPath)) {
      return;
    }
    visitedDirectories.add(resolvedDirectoryPath);

    let entries: Dirent[];
    try {
      entries = await fs.readdir(resolvedDirectoryPath, { withFileTypes: true });
    } catch (error) {
      if (hasErrnoCode(error, "ENOENT")) {
        return;
      }
      throw error;
    }

    for (const entry of entries) {
      const entryPath = path.join(resolvedDirectoryPath, entry.name);
      if (isPathWithin(entryPath, gatewayLockDir) || params.inventory.isVolatile(entryPath)) {
        continue;
      }
      if (entry.isDirectory()) {
        if (
          params.inventory.isTraversable(entryPath) &&
          !params.inventory.isPackageContent(entryPath)
        ) {
          await visit(entryPath);
        }
        continue;
      }
      // Exclusions win before symlink/stat handling; protected declarations
      // are already resolved by the inventory's include-over-exclude policy.
      if (!params.inventory.isIncluded(entryPath)) {
        continue;
      }
      if (entry.isSymbolicLink()) {
        if (resolveBackupAgentDatabaseOwner(entryPath, params.inventory)) {
          let targetEntry: Stats;
          try {
            targetEntry = await fs.stat(entryPath);
          } catch (error) {
            throw new Error(`Canonical agent SQLite symlink cannot be snapshotted: ${entryPath}`, {
              cause: error,
            });
          }
          if (!targetEntry.isFile()) {
            throw new Error(
              `Canonical agent SQLite symlink must resolve to a regular file: ${entryPath}`,
            );
          }
          snapshotPaths.add(entryPath);
          discoveredSourcePaths.add(entryPath);
        }
        continue;
      }
      if (!entry.isFile() || classifyBackupSqliteSource(entryPath, params.inventory) !== "sqlite") {
        continue;
      }
      discoveredSourcePaths.add(entryPath);
      if (entry.name.endsWith(".sqlite")) {
        snapshotPaths.add(entryPath);
      }
    }
  }

  await visit(params.inventory.stateDir);
  for (const { sourcePath } of params.inventory.agentRoots) {
    await visit(sourcePath);
  }

  const globalStateSqlitePath = path.resolve(params.globalStateSqlitePath);
  let globalStateEntry: Stats | undefined;
  try {
    globalStateEntry = await fs.lstat(globalStateSqlitePath);
  } catch (error) {
    if (!hasErrnoCode(error, "ENOENT")) {
      throw error;
    }
  }
  if (globalStateEntry?.isFile()) {
    snapshotPaths.add(globalStateSqlitePath);
    discoveredSourcePaths.add(globalStateSqlitePath);
  } else if (globalStateEntry?.isSymbolicLink()) {
    let targetEntry: Stats;
    try {
      targetEntry = await fs.stat(globalStateSqlitePath);
    } catch (error) {
      throw new Error(
        `Canonical global SQLite symlink cannot be snapshotted: ${globalStateSqlitePath}`,
        { cause: error },
      );
    }
    if (!targetEntry.isFile()) {
      throw new Error(
        `Canonical global SQLite symlink must resolve to a regular file: ${globalStateSqlitePath}`,
      );
    }
    snapshotPaths.add(globalStateSqlitePath);
    discoveredSourcePaths.add(globalStateSqlitePath);
  } else if (globalStateEntry) {
    throw new Error(
      `Canonical global SQLite path must be a regular file or symlink to one: ${globalStateSqlitePath}`,
    );
  }

  return {
    snapshotPaths: [...snapshotPaths].toSorted((left, right) => left.localeCompare(right)),
    discoveredSourcePaths,
  };
}

export async function createBackupSqliteSnapshotPlan(params: {
  inventory: BackupResourceInventory;
  tempDir: string;
  legacyAuditSnapshots: readonly LegacyAuditBackupSnapshot[];
  legacyAuditDatabaseWitness?: string;
}): Promise<{ snapshots: SqliteBackupAsset[]; discoveredSourcePaths: Set<string> }> {
  const globalStateSqlitePath = path.resolve(
    resolveOpenClawStateSqlitePath({
      ...process.env,
      OPENCLAW_STATE_DIR: params.inventory.stateDir,
    }),
  );
  // Discovery finishes before snapshot creation so staged files cannot become
  // additional backup sources, even when authoritative roots overlap.
  const discovery = await discoverBackupSqliteSources({
    inventory: params.inventory,
    globalStateSqlitePath,
  });
  const globalStateIdentity = await fs.stat(globalStateSqlitePath).catch((error: unknown) => {
    if (hasErrnoCode(error, "ENOENT")) {
      return undefined;
    }
    throw error;
  });
  const canonicalSources: CanonicalSqliteSource[] = [];
  if (globalStateIdentity) {
    canonicalSources.push({
      role: "global",
      archiveSourcePath: globalStateSqlitePath,
      identity: globalStateIdentity,
      sourcePath: await fs.realpath(globalStateSqlitePath),
    });
  }
  for (const archiveSourcePath of discovery.snapshotPaths) {
    const agentId = resolveBackupAgentDatabaseOwner(archiveSourcePath, params.inventory);
    if (!agentId) {
      continue;
    }
    if (normalizeAgentId(agentId) !== agentId) {
      throw new Error(
        `Canonical agent SQLite path has a noncanonical agent owner ${agentId}: ${archiveSourcePath}`,
      );
    }
    canonicalSources.push({
      role: "agent",
      agentId,
      archiveSourcePath,
      identity: await fs.stat(archiveSourcePath),
      sourcePath: await fs.realpath(archiveSourcePath),
    });
  }

  const snapshots: SqliteBackupAsset[] = [];
  for (const archiveSourcePath of discovery.snapshotPaths) {
    const archiveSourceIdentity = await fs.stat(archiveSourcePath);
    const exactCanonicalSource = canonicalSources.find(
      (source) => path.resolve(source.archiveSourcePath) === path.resolve(archiveSourcePath),
    );
    if (
      exactCanonicalSource &&
      !sameFileIdentity(exactCanonicalSource.identity, archiveSourceIdentity)
    ) {
      throw new Error(`Canonical SQLite path changed after discovery: ${archiveSourcePath}`);
    }
    const matchingCanonicalSources = exactCanonicalSource
      ? [exactCanonicalSource]
      : canonicalSources.filter((source) =>
          sameFileIdentity(source.identity, archiveSourceIdentity),
        );
    if (matchingCanonicalSources.length > 1) {
      const owners = matchingCanonicalSources
        .map((source) => (source.role === "global" ? "global" : `agent:${source.agentId}`))
        .join(", ");
      throw new Error(
        `SQLite path aliases multiple canonical database owners (${owners}): ${archiveSourcePath}`,
      );
    }
    const canonicalSource = matchingCanonicalSources[0];
    const sourceDatabasePath = canonicalSource?.sourcePath ?? archiveSourcePath;
    const sourcePath = path.join(params.tempDir, `openclaw-state-db-${snapshots.length}.sqlite`);
    try {
      await createVerifiedSqliteSnapshot({
        sourcePath: sourceDatabasePath,
        targetPath: sourcePath,
        requireNonEmptySource: Boolean(canonicalSource),
        validate:
          canonicalSource?.role === "global"
            ? (database, pathname) => assertOpenClawStateDatabaseOwner(database, { pathname })
            : canonicalSource?.role === "agent"
              ? (database, pathname) =>
                  assertOpenClawAgentDatabaseOwner(database, {
                    agentId: canonicalSource.agentId,
                    pathname,
                  })
              : undefined,
        transform:
          canonicalSource?.role === "global"
            ? (database) => {
                if (
                  params.legacyAuditDatabaseWitness !== undefined &&
                  createLegacyAuditDatabaseWitness(database) !== params.legacyAuditDatabaseWitness
                ) {
                  throw new LegacyAuditBackupStateChangedError(
                    "Legacy audit database rows changed during SQLite backup",
                  );
                }
                sanitizeOpenClawGlobalStateSnapshot(database);
                rewriteLegacyAuditBackupCheckpoints(database, params.legacyAuditSnapshots);
              }
            : canonicalSource?.role === "agent"
              ? sanitizeOpenClawStateLeaseRows
              : undefined,
      });
    } catch (error) {
      const stateChange = findLegacyAuditBackupStateChange(error);
      if (stateChange) {
        throw stateChange;
      }
      throw new Error(
        `SQLite database cannot be compacted safely for backup: ${archiveSourcePath}. ${formatErrorMessage(error)}. The source must pass full integrity checks, online SQLite backup, and offline compaction with its required SQLite capabilities; a direct file copy was refused because it can retain deleted data.`,
        { cause: error },
      );
    }
    snapshots.push({
      sourcePath,
      archiveSourcePath,
      skippedSourcePaths: new Set(
        [archiveSourcePath, sourceDatabasePath].flatMap((databasePath) =>
          resolveSqliteDatabaseFilePaths(databasePath).map((pathname) => path.resolve(pathname)),
        ),
      ),
    });
  }
  return { snapshots, discoveredSourcePaths: discovery.discoveredSourcePaths };
}
