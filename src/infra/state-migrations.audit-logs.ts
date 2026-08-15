// Doctor-only import for retired core JSONL audit stores.
import fs from "node:fs";
import path from "node:path";
import {
  CONFIG_AUDIT_MAX_ENTRIES,
  CONFIG_AUDIT_SCOPE,
  type ConfigAuditRecord,
} from "../config/io.audit.js";
import {
  SYSTEM_AGENT_AUDIT_MAX_ENTRIES,
  SYSTEM_AGENT_AUDIT_SCOPE,
  type SystemAgentAuditEntry,
} from "../system-agent/audit.js";
import { root as createFsSafeRoot } from "./fs-safe.js";
import { acquireGatewayLock } from "./gateway-lock.js";
import { createSqliteAuditRecordStore } from "./sqlite-audit-record-store.js";
import {
  hasLegacyAuditRawCheckpointCapacity,
  legacyAuditSourceGenerationKey,
} from "./state-migrations.audit-checkpoints.js";
import { withLegacyAuditMigrationLease } from "./state-migrations.audit-coordination.js";
import type {
  LegacyAuditLogSource,
  LegacyAuditLogsDetection,
} from "./state-migrations.audit-logs.types.js";
import {
  prepareLegacyAuditRecords,
  serializePreparedAuditRecords,
  type PreparedAuditRecord,
} from "./state-migrations.audit-records.js";
import {
  finalizeLegacyAuditRecoveryArchive,
  findPreviousLegacyAuditRawCheckpoint,
  readLegacyAuditSourceSnapshot,
  recordLegacyAuditRawCheckpoint,
  recordsAfterLegacyAuditRawCheckpoint,
  restoreInterruptedAuditRecoveryArchive,
  scrubLegacyAuditRecoveryArchive,
  type AuditMigrationRoot,
  type LegacyAuditSourceSnapshot,
} from "./state-migrations.audit-recovery.js";
import { writeRecoveredSanitizedAuditArchive } from "./state-migrations.audit-sanitized.js";
import type { MigrationMessages } from "./state-migrations.types.js";

function legacyAuditClaimPathForArchive(sourcePath: string, sanitizedArchivePath: string): string {
  const archivePrefix = `${sourcePath}.migrated`;
  if (!sanitizedArchivePath.startsWith(archivePrefix)) {
    throw new Error(`Invalid legacy audit archive path ${sanitizedArchivePath}`);
  }
  const generationSuffix = sanitizedArchivePath.slice(archivePrefix.length);
  return path.join(
    path.dirname(sourcePath),
    `.${path.basename(sourcePath)}.doctor-importing${generationSuffix}`,
  );
}

export { detectLegacyAuditLogs } from "./state-migrations.audit-checkpoints.js";

type AuditArchiveRelativePaths = {
  sanitized: string;
  raw: string;
  resumeSanitized: boolean;
};

async function resolveAuditArchiveRelativePaths(
  root: AuditMigrationRoot,
  sourceRelativePath: string,
): Promise<AuditArchiveRelativePaths> {
  const directoryPath = path.join(root.rootReal, path.dirname(sourceRelativePath));
  const baseName = path.basename(sourceRelativePath).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const archivePattern = new RegExp(
    `^${baseName}\\.migrated(?:\\.([2-9]|[1-9][0-9]+))?(?:\\.raw)?$`,
    "u",
  );
  const claimPattern = new RegExp(
    `^\\.${baseName}\\.doctor-importing(?:\\.([2-9]|[1-9][0-9]+))?$`,
    "u",
  );
  let latestGeneration = 0n;
  for (const entry of fs.readdirSync(directoryPath)) {
    const match = archivePattern.exec(entry) ?? claimPattern.exec(entry);
    if (!match) {
      continue;
    }
    const generation = BigInt(match[1] ?? "1");
    if (generation > latestGeneration) {
      latestGeneration = generation;
    }
  }
  const generation = latestGeneration + 1n;
  const sanitized = `${sourceRelativePath}.migrated${generation === 1n ? "" : `.${generation}`}`;
  return { sanitized, raw: `${sanitized}.raw`, resumeSanitized: false };
}

async function secureAuditArchiveFile(params: {
  root: AuditMigrationRoot;
  relativePath: string;
  label: string;
  warnings: string[];
}): Promise<boolean> {
  try {
    const opened = await params.root.open(params.relativePath);
    try {
      await opened.handle.chmod(0o600);
      await opened.handle.sync();
    } finally {
      await opened.handle.close();
    }
    return true;
  } catch (error) {
    params.warnings.push(`Failed securing ${params.label} legacy source: ${String(error)}`);
    return false;
  }
}

async function archiveLegacyAuditClaim(params: {
  source: LegacyAuditLogSource;
  claimRelativePath: string;
  archivePaths: { sanitized: string; raw: string; resumeSanitized: boolean };
  snapshot: LegacyAuditSourceSnapshot;
  sanitizedJsonl: string;
  root: AuditMigrationRoot;
  changes: string[];
  warnings: string[];
}): Promise<{
  moved: boolean;
  rawRelativePath?: string;
  scrubbedSnapshot?: LegacyAuditSourceSnapshot;
}> {
  let moved = false;
  let sanitizedCreated = false;
  const archivePaths = params.archivePaths;
  try {
    if (archivePaths.resumeSanitized) {
      await params.root.write(archivePaths.sanitized, params.sanitizedJsonl, {
        mkdir: false,
        mode: 0o600,
      });
    } else {
      await params.root.create(archivePaths.sanitized, params.sanitizedJsonl, { mode: 0o600 });
    }
    sanitizedCreated = true;
    if (
      !(await secureAuditArchiveFile({
        root: params.root,
        relativePath: archivePaths.sanitized,
        label: `sanitized ${params.source.label}`,
        warnings: params.warnings,
      }))
    ) {
      return { moved: false };
    }
    // Keep the claimed inode intact. A predecessor CLI may already hold an append
    // descriptor across the claim; moving that inode to a named migration backup
    // preserves any late write while the sanitized sibling remains safe to inspect.
    await params.root.move(params.claimRelativePath, archivePaths.raw);
    if (
      !(await secureAuditArchiveFile({
        root: params.root,
        relativePath: archivePaths.raw,
        label: `raw archived ${params.source.label}`,
        warnings: params.warnings,
      }))
    ) {
      try {
        await params.root.move(archivePaths.raw, params.claimRelativePath);
      } catch (error) {
        params.warnings.push(
          `Failed restoring unsecured ${params.source.label} legacy source: ${String(error)}`,
        );
      }
      return { moved: false };
    }
    moved = true;
    const scrubbedSnapshot = await scrubLegacyAuditRecoveryArchive({
      root: params.root,
      relativePath: archivePaths.raw,
      expectedSnapshot: params.snapshot,
      label: params.source.label,
      warnings: params.warnings,
    });
    params.changes.push(
      `Archived sanitized ${params.source.label} legacy source → ${path.join(path.dirname(params.source.logicalSourcePath), path.basename(archivePaths.sanitized))}; ${scrubbedSnapshot ? "scrubbed same-inode append recovery archive" : "retained same-inode append recovery archive for Doctor retry"} → ${path.join(path.dirname(params.source.logicalSourcePath), path.basename(archivePaths.raw))}`,
    );
    return {
      moved: true,
      rawRelativePath: archivePaths.raw,
      ...(scrubbedSnapshot ? { scrubbedSnapshot } : {}),
    };
  } catch (error) {
    params.warnings.push(
      `Failed archiving ${params.source.label} ${params.source.logicalSourcePath}: ${String(error)}`,
    );
  } finally {
    if (!moved && sanitizedCreated) {
      await params.root.remove(archivePaths.sanitized).catch(() => undefined);
    }
  }
  return { moved, ...(moved ? { rawRelativePath: archivePaths.raw } : {}) };
}

async function restoreOrPreserveLegacyAuditClaim(params: {
  source: LegacyAuditLogSource;
  claimRelativePath: string;
  sourceRelativePath: string;
  archivePaths: AuditArchiveRelativePaths;
  root: AuditMigrationRoot;
  warnings: string[];
}): Promise<void> {
  try {
    if (!(await params.root.exists(params.claimRelativePath))) {
      return;
    }
    if (!(await params.root.exists(params.sourceRelativePath))) {
      await params.root.move(params.claimRelativePath, params.sourceRelativePath);
      await secureAuditArchiveFile({
        root: params.root,
        relativePath: params.sourceRelativePath,
        label: params.source.label,
        warnings: params.warnings,
      });
      return;
    }
    await params.root.move(params.claimRelativePath, params.archivePaths.raw);
    await secureAuditArchiveFile({
      root: params.root,
      relativePath: params.archivePaths.raw,
      label: `preserved ${params.source.label}`,
      warnings: params.warnings,
    });
    params.warnings.push(
      `Preserved claimed ${params.source.label} at ${path.join(path.dirname(params.source.logicalSourcePath), path.basename(params.archivePaths.raw))} because an old writer recreated ${params.source.logicalSourcePath}`,
    );
  } catch (error) {
    params.warnings.push(
      `Failed restoring claimed ${params.source.label} ${params.source.logicalSourcePath}: ${String(error)}`,
    );
  }
}

async function migrateLegacyAuditLogSource(params: {
  source: LegacyAuditLogSource;
  stateDir: string;
  recreatedSourceScheduled?: boolean;
}): Promise<MigrationMessages & { completed: boolean }> {
  const changes: string[] = [];
  const warnings: string[] = [];
  const result = (completed: boolean) => ({ changes, warnings, completed });
  const root = await createFsSafeRoot(params.stateDir, {
    hardlinks: "reject",
    // Doctor previously accepted the complete legacy log; keep that migration
    // contract while root operations enforce path and symlink boundaries.
    maxBytes: Number.MAX_SAFE_INTEGER,
    mkdir: false,
    mode: 0o600,
    symlinks: "reject",
  });
  const sourceRelativePath = path.relative(
    path.resolve(params.stateDir),
    params.source.logicalSourcePath,
  );
  const detectedRelativePath = path.relative(
    path.resolve(params.stateDir),
    params.source.sourcePath,
  );
  let archivePaths: AuditArchiveRelativePaths | undefined;
  let claimRelativePath = detectedRelativePath;
  if (params.source.storage === "active") {
    archivePaths = await resolveAuditArchiveRelativePaths(root, sourceRelativePath);
    claimRelativePath = path.relative(
      path.resolve(params.stateDir),
      legacyAuditClaimPathForArchive(
        params.source.logicalSourcePath,
        path.join(params.stateDir, archivePaths.sanitized),
      ),
    );
    await root.move(detectedRelativePath, claimRelativePath);
  } else if (params.source.storage === "claim") {
    if (!params.source.sanitizedArchivePath || !params.source.rawArchivePath) {
      throw new Error(`Missing reserved archive generation for ${params.source.sourcePath}`);
    }
    const sanitized = path.relative(
      path.resolve(params.stateDir),
      params.source.sanitizedArchivePath,
    );
    const raw = path.relative(path.resolve(params.stateDir), params.source.rawArchivePath);
    archivePaths = {
      sanitized,
      raw,
      resumeSanitized: (await root.exists(sanitized)) && !(await root.exists(raw)),
    };
  }
  let claimFinalized = params.source.storage === "raw-archive";
  try {
    if (
      !(await secureAuditArchiveFile({
        root,
        relativePath: claimRelativePath,
        label: `claimed ${params.source.label}`,
        warnings,
      }))
    ) {
      return result(false);
    }
    const rawArchiveRelativePath = archivePaths?.raw ?? detectedRelativePath;
    if (!hasLegacyAuditRawCheckpointCapacity(params.stateDir, rawArchiveRelativePath)) {
      warnings.push(
        `Skipped ${params.source.label} migration because durable raw-archive checkpoint capacity is exhausted; left the legacy source in place`,
      );
      return result(false);
    }
    if (
      !(await restoreInterruptedAuditRecoveryArchive({
        root,
        relativePath: claimRelativePath,
        label: params.source.label,
        warnings,
      }))
    ) {
      return result(false);
    }
    const snapshot = await readLegacyAuditSourceSnapshot(root, claimRelativePath);
    const sourceGeneration = legacyAuditSourceGenerationKey(rawArchiveRelativePath);
    const sanitizedRelativePath =
      params.source.storage === "raw-archive" && params.source.sanitizedArchivePath
        ? path.relative(path.resolve(params.stateDir), params.source.sanitizedArchivePath)
        : undefined;
    const previousCheckpoint =
      params.source.storage === "raw-archive"
        ? findPreviousLegacyAuditRawCheckpoint(params.stateDir, rawArchiveRelativePath)
        : undefined;
    if (params.source.storage === "raw-archive" && !previousCheckpoint) {
      if (!sanitizedRelativePath) {
        throw new Error(`Missing sanitized archive path for ${params.source.sourcePath}`);
      }
      const firstContentByte = snapshot.rawBytes.findIndex(
        (byte) => byte !== 0x20 && byte !== 0x09 && byte !== 0x0a && byte !== 0x0d,
      );
      if (snapshot.rawBytes.length > 0 && firstContentByte !== 0) {
        warnings.push(
          `Skipped ${params.source.label} recovery because its checkpointless raw archive begins with ambiguous whitespace; left the archive in place`,
        );
        return result(false);
      }
    }
    const prepared = prepareLegacyAuditRecords(
      params.source,
      snapshot.raw,
      sourceGeneration,
      previousCheckpoint?.recordOrdinalBase ?? 0,
    );
    if (!prepared.ok) {
      warnings.push(...prepared.warnings);
      return result(false);
    }
    const env = { ...process.env, OPENCLAW_STATE_DIR: params.stateDir };
    const maxEntries =
      params.source.kind === "config" ? CONFIG_AUDIT_MAX_ENTRIES : SYSTEM_AGENT_AUDIT_MAX_ENTRIES;
    const store = createSqliteAuditRecordStore<ConfigAuditRecord | SystemAgentAuditEntry>({
      scope: params.source.kind === "config" ? CONFIG_AUDIT_SCOPE : SYSTEM_AGENT_AUDIT_SCOPE,
      maxEntries,
      env,
    });
    const existingEntries = store.entries();
    const existingKeys = new Set(existingEntries.map((entry) => entry.key));
    let candidateRecords: readonly PreparedAuditRecord[] = prepared.records;
    if (params.source.storage === "raw-archive") {
      if (previousCheckpoint) {
        const appendedRecords = recordsAfterLegacyAuditRawCheckpoint({
          checkpoint: previousCheckpoint,
          snapshot,
          records: prepared.records,
        });
        if (!appendedRecords) {
          warnings.push(
            `Skipped ${params.source.label} recovery because ${params.source.sourcePath} changed other than by append; left the raw archive in place`,
          );
          return result(false);
        }
        candidateRecords = appendedRecords;
      }
    }
    if (!previousCheckpoint && candidateRecords === prepared.records) {
      const lastRetainedSourceIndex = prepared.records.findLastIndex((record) =>
        existingKeys.has(record.key),
      );
      if (lastRetainedSourceIndex >= 0) {
        // A crash can occur after bounded insertion but before its raw checkpoint.
        // Continue after the latest retained source ordinal instead of resurrecting
        // the pruned head as newly appended audit history.
        candidateRecords = prepared.records.slice(lastRetainedSourceIndex + 1);
      }
    }
    const missing = candidateRecords.filter((record) => !existingKeys.has(record.key));
    // SQLite may commit before the sanitized merge/checkpoint. Keep raw-derived
    // candidates intact so retry can still prove and materialize the artifact tail.
    store.registerLegacyMany(missing);
    const importedKeys = new Set(store.entries().map((entry) => entry.key));
    const retainedNewRows = missing.filter((record) => importedKeys.has(record.key)).length;
    const retentionNote =
      retainedNewRows === missing.length
        ? ""
        : `; ${retainedNewRows} retained after bounded retention`;
    if (params.source.storage === "raw-archive") {
      if (!sanitizedRelativePath) {
        throw new Error(`Missing sanitized archive path for ${params.source.sourcePath}`);
      }
      if (
        !(await writeRecoveredSanitizedAuditArchive({
          sourceLabel: params.source.label,
          root,
          relativePath: sanitizedRelativePath,
          allRecordsJsonl: prepared.sanitizedJsonl,
          candidateRecordsJsonl: serializePreparedAuditRecords(candidateRecords),
          previousCheckpoint,
          warnings,
        }))
      ) {
        return result(false);
      }
      // Checkpoint the unscrubbed append before hardening/scrubbing. A retry can
      // then prove the sanitized tail was already written instead of duplicating it.
      // A merge-intent count describes its exact raw snapshot. Keep an existing
      // intent untouched when retry has no later rows; the final raw checkpoint replaces it.
      if (previousCheckpoint?.phase !== "merge-intent" || candidateRecords.length > 0) {
        if (
          !(await recordLegacyAuditRawCheckpoint({
            stateDir: params.stateDir,
            rawPath: params.source.sourcePath,
            rawRelativePath: claimRelativePath,
            sanitizedRelativePath,
            root,
            snapshot,
            phase: "merge-intent",
            recordCount: prepared.records.length,
            recordOrdinalBase: previousCheckpoint?.recordOrdinalBase ?? 0,
            warnings,
          }))
        ) {
          return result(false);
        }
      }
      if (
        !(await secureAuditArchiveFile({
          root,
          relativePath: sanitizedRelativePath,
          label: `sanitized ${params.source.label}`,
          warnings,
        }))
      ) {
        return result(false);
      }
      if (missing.length > 0) {
        changes.push(
          `Recovered ${missing.length} later ${params.source.label} row(s) from ${params.source.sourcePath}${retentionNote}`,
        );
      }
      const scrubbedSnapshot = await scrubLegacyAuditRecoveryArchive({
        root,
        relativePath: claimRelativePath,
        expectedSnapshot: snapshot,
        label: params.source.label,
        warnings,
      });
      if (!scrubbedSnapshot) {
        return result(false);
      }
      const scrubbedRecords = prepareLegacyAuditRecords(
        params.source,
        scrubbedSnapshot.raw,
        legacyAuditSourceGenerationKey(rawArchiveRelativePath),
      );
      if (!scrubbedRecords.ok) {
        warnings.push(...scrubbedRecords.warnings);
        warnings.push(
          `Retained uncheckpointed ${params.source.label} recovery archive; rerun openclaw doctor --fix`,
        );
        return result(false);
      }
      if (scrubbedRecords.records.length !== 0) {
        warnings.push(
          `A legacy ${params.source.label} writer appended during recovery; rerun openclaw doctor --fix to import the retained rows`,
        );
        return result(false);
      }
      const checkpointed = await recordLegacyAuditRawCheckpoint({
        stateDir: params.stateDir,
        rawPath: params.source.sourcePath,
        rawRelativePath: claimRelativePath,
        sanitizedRelativePath,
        root,
        snapshot: scrubbedSnapshot,
        phase: "raw",
        recordCount: 0,
        recordOrdinalBase:
          (previousCheckpoint?.recordOrdinalBase ?? 0) +
          Math.max(previousCheckpoint?.recordCount ?? 0, prepared.records.length),
        warnings,
      });
      if (checkpointed) {
        await finalizeLegacyAuditRecoveryArchive({ root, relativePath: claimRelativePath }).catch(
          (error: unknown) => {
            warnings.push(
              `Failed removing completed ${params.source.label} recovery journal: ${String(error)}`,
            );
          },
        );
      }
      return result(checkpointed);
    }
    if (!archivePaths) {
      throw new Error(`Missing archive generation for ${params.source.sourcePath}`);
    }
    changes.push(
      `Migrated ${params.source.label} -> shared SQLite state (${missing.length} new row(s)${retentionNote})`,
    );
    const archived = await archiveLegacyAuditClaim({
      source: params.source,
      claimRelativePath,
      archivePaths,
      snapshot,
      sanitizedJsonl: prepared.sanitizedJsonl,
      root,
      changes,
      warnings,
    });
    claimFinalized = archived.moved;
    if (!archived.moved || !archived.rawRelativePath) {
      changes.pop();
      return result(false);
    }
    if (!archived.scrubbedSnapshot) {
      return result(false);
    }
    const scrubbedRecords = prepareLegacyAuditRecords(
      params.source,
      archived.scrubbedSnapshot.raw,
      legacyAuditSourceGenerationKey(archived.rawRelativePath),
    );
    if (!scrubbedRecords.ok) {
      warnings.push(...scrubbedRecords.warnings);
      warnings.push(
        `Retained uncheckpointed ${params.source.label} recovery archive; rerun openclaw doctor --fix`,
      );
      return result(false);
    }
    if (scrubbedRecords.records.length !== 0) {
      warnings.push(
        `A legacy ${params.source.label} writer appended during migration; rerun openclaw doctor --fix to import the retained rows`,
      );
      return result(false);
    }
    const rawPath = path.join(params.stateDir, archived.rawRelativePath);
    const checkpointed = await recordLegacyAuditRawCheckpoint({
      stateDir: params.stateDir,
      rawPath,
      rawRelativePath: archived.rawRelativePath,
      sanitizedRelativePath: archivePaths.sanitized,
      root,
      snapshot: archived.scrubbedSnapshot,
      phase: "raw",
      recordCount: 0,
      recordOrdinalBase: prepared.records.length,
      warnings,
    });
    if (checkpointed) {
      await finalizeLegacyAuditRecoveryArchive({
        root,
        relativePath: archived.rawRelativePath,
      }).catch((error: unknown) => {
        warnings.push(
          `Failed removing completed ${params.source.label} recovery journal: ${String(error)}`,
        );
      });
    }
    if ((await root.exists(sourceRelativePath)) && !params.recreatedSourceScheduled) {
      warnings.push(
        `An old writer recreated ${params.source.label} at ${params.source.logicalSourcePath}; rerun openclaw doctor --fix to import the retained rows`,
      );
    }
    return result(checkpointed);
  } finally {
    if (!claimFinalized && params.source.storage === "active" && archivePaths) {
      await restoreOrPreserveLegacyAuditClaim({
        source: params.source,
        claimRelativePath,
        sourceRelativePath,
        archivePaths,
        root,
        warnings,
      });
    }
  }
}

export async function migrateLegacyAuditLogs(params: {
  detected: LegacyAuditLogsDetection;
  stateDir: string;
}): Promise<MigrationMessages> {
  const changes: string[] = [];
  const warnings: string[] = [];
  if (params.detected.sources.length === 0) {
    return { changes, warnings };
  }
  const env = { ...process.env, OPENCLAW_STATE_DIR: params.stateDir };
  let lock: Awaited<ReturnType<typeof acquireGatewayLock>>;
  try {
    // Exclusive state ownership excludes a predecessor Gateway and sibling doctor.
    // Each source is also atomically claimed because old short-lived CLI processes
    // can append config audit rows without participating in the Gateway lock.
    lock = await acquireGatewayLock({
      allowInTests: true,
      env,
      pollIntervalMs: 25,
      role: "sqlite-maintenance",
      timeoutMs: 250,
    });
  } catch (error) {
    warnings.push(
      `Skipped legacy audit migration because exclusive state ownership is unavailable: ${String(error)}`,
    );
    return { changes, warnings };
  }
  if (!lock) {
    warnings.push(
      "Skipped legacy audit migration because exclusive state ownership is unavailable",
    );
    return { changes, warnings };
  }
  try {
    await withLegacyAuditMigrationLease(params.stateDir, async () => {
      const blockedLogicalSources = new Set<string>();
      for (const [index, source] of params.detected.sources.entries()) {
        if (blockedLogicalSources.has(source.logicalSourcePath)) {
          continue;
        }
        try {
          const recreatedSourceScheduled = params.detected.sources
            .slice(index + 1)
            .some(
              (candidate) =>
                candidate.storage === "active" &&
                candidate.logicalSourcePath === source.logicalSourcePath,
            );
          const result = await migrateLegacyAuditLogSource({
            source,
            stateDir: params.stateDir,
            ...(recreatedSourceScheduled ? { recreatedSourceScheduled: true } : {}),
          });
          changes.push(...result.changes);
          warnings.push(...result.warnings);
          if (!result.completed) {
            // Generations encode append order. A later archive must not overtake
            // an older source that still needs repair or durable checkpointing.
            blockedLogicalSources.add(source.logicalSourcePath);
          }
        } catch (error) {
          warnings.push(`Failed migrating ${source.label}: ${String(error)}`);
          blockedLogicalSources.add(source.logicalSourcePath);
        }
      }
    });
  } catch (error) {
    warnings.push(`Skipped legacy audit migration because coordination failed: ${String(error)}`);
  } finally {
    await lock.release();
  }
  return { changes, warnings };
}
