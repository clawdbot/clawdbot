// Builds secret-sanitized backup replacements for legacy audit append archives.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { root as createFsSafeRoot } from "./fs-safe.js";
import {
  detectLegacyAuditLogs,
  legacyAuditRawCheckpointKey,
  legacyAuditSourceGenerationKey,
  type LegacyAuditRawCheckpoint,
} from "./state-migrations.audit-checkpoints.js";
import {
  prepareLegacyAuditRecords,
  serializePreparedAuditRecords,
} from "./state-migrations.audit-records.js";
import {
  findPreviousLegacyAuditRawCheckpoint,
  readLegacyAuditRecoverySourceForBackup,
  readLegacyAuditSourcePrefixSnapshotForBackup,
} from "./state-migrations.audit-recovery.js";

const LEGACY_AUDIT_LOGICAL_PATHS = [
  { directory: "logs", basename: "config-audit.jsonl" },
  { directory: "audit", basename: "system-agent.jsonl" },
  { directory: "audit", basename: "crestodian.jsonl" },
] as const;

export async function hasLegacyAuditBackupSources(stateDir: string): Promise<boolean> {
  for (const logical of LEGACY_AUDIT_LOGICAL_PATHS) {
    let entries: string[];
    try {
      entries = await fs.readdir(path.join(stateDir, logical.directory));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw error;
    }
    const escaped = logical.basename.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const sourcePattern = new RegExp(
      `^(?:${escaped}|\\.${escaped}\\.doctor-importing(?:\\.(?:[2-9]|[1-9][0-9]+))?|${escaped}\\.migrated(?:\\.(?:[2-9]|[1-9][0-9]+))?\\.raw(?:\\.doctor-scrub-(?:progress|restore|staging))?)$`,
      "u",
    );
    if (entries.some((entry) => sourcePattern.test(entry))) {
      return true;
    }
  }
  return false;
}

export function isLegacyAuditMigrationBackupPath(sourcePath: string, stateDir: string): boolean {
  const relativePath = path.relative(path.resolve(stateDir), path.resolve(sourcePath));
  if (!relativePath || relativePath.startsWith(`..${path.sep}`) || path.isAbsolute(relativePath)) {
    return false;
  }
  const directory = path.dirname(relativePath);
  const basename = path.basename(relativePath);
  for (const logical of LEGACY_AUDIT_LOGICAL_PATHS) {
    if (directory !== logical.directory) {
      continue;
    }
    if (basename === logical.basename) {
      return true;
    }
    const escaped = logical.basename.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const claimPattern = new RegExp(
      `^\\.${escaped}\\.doctor-importing(?:\\.(?:[2-9]|[1-9][0-9]+))?$`,
      "u",
    );
    const rawPattern = new RegExp(
      `^${escaped}\\.migrated(?:\\.(?:[2-9]|[1-9][0-9]+))?\\.raw(?:\\.doctor-scrub-(?:progress|restore|staging))?$`,
      "u",
    );
    if (claimPattern.test(basename) || rawPattern.test(basename)) {
      return true;
    }
  }
  return false;
}

type LegacyAuditBackupCheckpoint = {
  key: string;
  value: LegacyAuditRawCheckpoint;
};

export type LegacyAuditBackupSnapshot = {
  sourcePath: string;
  archiveSourcePath: string;
  skippedSourcePaths: Set<string>;
  checkpoint?: LegacyAuditBackupCheckpoint;
};

/** Replaces live raw checkpoints with metadata for the transformed backup files. */
export function rewriteLegacyAuditBackupCheckpoints(
  database: DatabaseSync,
  snapshots: readonly LegacyAuditBackupSnapshot[],
): void {
  const hasDiagnosticEvents = database // sqlite-allow-raw -- Offline snapshot maintenance boundary.
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get("diagnostic_events") as { ok?: unknown } | undefined;
  if (hasDiagnosticEvents?.ok !== 1) {
    return;
  }
  const scope = "migration.legacy-audit-raw";
  database.prepare("DELETE FROM diagnostic_events WHERE scope = ?").run(scope); // sqlite-allow-raw -- Offline snapshot maintenance boundary.
  const insert = database // sqlite-allow-raw -- Offline snapshot maintenance boundary.
    .prepare(
      `INSERT INTO diagnostic_events (
        scope, event_key, payload_json, created_at, sequence
      ) VALUES (?, ?, ?, ?, ?)`,
    );
  let sequence = 1;
  for (const snapshot of snapshots) {
    if (!snapshot.checkpoint) {
      continue;
    }
    insert.run(
      scope,
      snapshot.checkpoint.key,
      JSON.stringify(snapshot.checkpoint.value),
      0,
      sequence,
    );
    sequence += 1;
  }
}

async function createLegacyAuditBackupSnapshotsOnce(params: {
  stateDir: string;
  tempDir: string;
}): Promise<LegacyAuditBackupSnapshot[]> {
  const detected = detectLegacyAuditLogs({
    stateDir: params.stateDir,
    doctorOnlyStateMigrations: true,
  });
  if (detected.sources.length === 0) {
    return [];
  }
  const root = await createFsSafeRoot(params.stateDir, {
    hardlinks: "reject",
    maxBytes: Number.MAX_SAFE_INTEGER,
    mkdir: false,
    mode: 0o600,
    symlinks: "reject",
  });
  const snapshots: LegacyAuditBackupSnapshot[] = [];
  for (const [index, source] of detected.sources.entries()) {
    const sourceRelativePath = path.relative(path.resolve(params.stateDir), source.sourcePath);
    const snapshot =
      source.storage === "raw-archive"
        ? await readLegacyAuditRecoverySourceForBackup(root, sourceRelativePath)
        : await readLegacyAuditSourcePrefixSnapshotForBackup(root, sourceRelativePath);
    const sourceGeneration = legacyAuditSourceGenerationKey(sourceRelativePath);
    const previousCheckpoint =
      source.storage === "raw-archive"
        ? findPreviousLegacyAuditRawCheckpoint(params.stateDir, sourceRelativePath)
        : undefined;
    const prepared = prepareLegacyAuditRecords(
      source,
      snapshot.raw,
      sourceGeneration,
      previousCheckpoint?.recordOrdinalBase ?? 0,
    );
    if (!prepared.ok) {
      throw new Error(
        `Legacy ${source.label} append archive cannot be sanitized for backup: ${prepared.warnings.join("; ")}`,
      );
    }
    const sourcePath = path.join(params.tempDir, `legacy-audit-raw-${index}.jsonl`);
    await fs.writeFile(sourcePath, prepared.sanitizedJsonl, { mode: 0o600 });
    let checkpoint: LegacyAuditBackupCheckpoint | undefined;
    if (previousCheckpoint) {
      if (previousCheckpoint.recordCount > prepared.records.length) {
        throw new Error(
          `Legacy ${source.label} append archive is shorter than its durable checkpoint`,
        );
      }
      // Backup rewrites raw bytes to sanitized JSONL. Preserve the source ordinal
      // and rebase the checkpoint hash onto the equivalent transformed prefix.
      const transformedPrefix = Buffer.from(
        serializePreparedAuditRecords(prepared.records.slice(0, previousCheckpoint.recordCount)),
        "utf8",
      );
      const value: LegacyAuditRawCheckpoint = {
        ...previousCheckpoint,
        dev: 0,
        ino: 0,
        mtimeMs: 0,
        size: transformedPrefix.length,
        contentHash: createHash("sha256").update(transformedPrefix).digest("hex"),
      };
      checkpoint = { key: legacyAuditRawCheckpointKey(value), value };
    }
    snapshots.push({
      sourcePath,
      archiveSourcePath: source.sourcePath,
      ...(checkpoint ? { checkpoint } : {}),
      skippedSourcePaths: new Set([
        path.resolve(source.sourcePath),
        path.resolve(`${source.sourcePath}.doctor-scrub-progress`),
        path.resolve(`${source.sourcePath}.doctor-scrub-restore`),
        path.resolve(`${source.sourcePath}.doctor-scrub-staging`),
      ]),
    });
  }
  return snapshots;
}

export async function createLegacyAuditBackupSnapshots(params: {
  stateDir: string;
  tempDir: string;
}): Promise<LegacyAuditBackupSnapshot[]> {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      return await createLegacyAuditBackupSnapshotsOnce(params);
    } catch (error) {
      lastError = error;
      if (attempt < 2) {
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 25);
        });
      }
    }
  }
  throw lastError;
}
