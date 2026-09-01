// Builds secret-sanitized backup replacements for legacy audit append archives.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { DatabaseSync } from "node:sqlite";
import { CONFIG_AUDIT_SCOPE } from "../config/io.audit.js";
import { resolveOpenClawStateSqlitePath } from "../state/openclaw-state-db.paths.js";
import { SYSTEM_AGENT_AUDIT_SCOPE } from "../system-agent/audit.js";
import { hasErrnoCode } from "./errno.js";
import { root as createFsSafeRoot } from "./fs-safe.js";
import { openNodeSqliteDatabase } from "./node-sqlite.js";
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
  // system-agent.jsonl never shipped in a stable, but beta installs that ran
  // its import left backup artifacts this list must keep recognizing.
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
    const archivePattern = new RegExp(
      `^${escaped}\\.migrated(?:\\.(?:[2-9]|[1-9][0-9]+))?(?:\\.raw(?:\\.doctor-scrub-(?:progress|restore|staging))?)?$`,
      "u",
    );
    if (claimPattern.test(basename) || archivePattern.test(basename)) {
      return true;
    }
  }
  return false;
}

type LegacyAuditBackupCheckpoint = {
  key: string;
  value: LegacyAuditRawCheckpoint;
};

type LegacyAuditBackupSourceWitness = {
  dev: number;
  ino: number;
  mtimeMs: number;
  size: number;
  sanitizedContentHash: string;
};

export type LegacyAuditBackupSnapshot = {
  sourcePath: string;
  archiveSourcePath: string;
  skippedSourcePaths: Set<string>;
  sourceWitness: LegacyAuditBackupSourceWitness;
  checkpoint?: LegacyAuditBackupCheckpoint;
};

export type LegacyAuditBackupCapture = {
  snapshots: LegacyAuditBackupSnapshot[];
  databaseWitness: string;
};

export class LegacyAuditBackupStateChangedError extends Error {
  constructor(message = "Legacy audit state changed while backup was capturing it") {
    super(message);
    this.name = "LegacyAuditBackupStateChangedError";
  }
}

const LEGACY_AUDIT_RAW_CHECKPOINT_SCOPE = "migration.legacy-audit-raw";

export function createLegacyAuditDatabaseWitness(database: DatabaseSync): string {
  const hasDiagnosticEvents = database // sqlite-allow-raw -- Read-only backup witness boundary.
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get("diagnostic_events") as { ok?: unknown } | undefined; // SAFETY: fixed SELECT returns `ok` or no row.
  const hash = createHash("sha256");
  if (hasDiagnosticEvents?.ok !== 1) {
    return hash.digest("hex");
  }
  const statement = database // sqlite-allow-raw -- Read-only backup witness boundary.
    .prepare(
      `SELECT scope, event_key, payload_json, created_at, sequence
       FROM diagnostic_events
       WHERE (scope IN (?, ?) AND event_key GLOB 'legacy:*') OR scope = ?
       ORDER BY scope, event_key, sequence`,
    );
  const rows = statement.all(
    CONFIG_AUDIT_SCOPE,
    SYSTEM_AGENT_AUDIT_SCOPE,
    LEGACY_AUDIT_RAW_CHECKPOINT_SCOPE,
  );
  for (const row of rows) {
    const serialized = JSON.stringify([
      row.scope,
      row.event_key,
      row.payload_json,
      row.created_at,
      row.sequence,
    ]);
    hash.update(String(Buffer.byteLength(serialized)));
    hash.update(":");
    hash.update(serialized);
  }
  return hash.digest("hex");
}

async function readLegacyAuditDatabaseWitness(stateDir: string): Promise<string> {
  const databasePath = resolveOpenClawStateSqlitePath({
    ...process.env,
    OPENCLAW_STATE_DIR: stateDir,
  });
  try {
    await fs.access(databasePath);
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return createHash("sha256").digest("hex");
    }
    throw error;
  }
  const database = openNodeSqliteDatabase(databasePath, { readOnly: true });
  try {
    return createLegacyAuditDatabaseWitness(database);
  } finally {
    database.close();
  }
}

export function legacyAuditBackupCapturesMatch(
  left: LegacyAuditBackupCapture,
  right: LegacyAuditBackupCapture,
): boolean {
  if (
    left.databaseWitness !== right.databaseWitness ||
    left.snapshots.length !== right.snapshots.length
  ) {
    return false;
  }
  return left.snapshots.every((snapshot, index) => {
    const candidate = right.snapshots[index];
    return (
      candidate !== undefined &&
      snapshot.archiveSourcePath === candidate.archiveSourcePath &&
      JSON.stringify(snapshot.sourceWitness) === JSON.stringify(candidate.sourceWitness) &&
      JSON.stringify(snapshot.checkpoint) === JSON.stringify(candidate.checkpoint)
    );
  });
}

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
      sourceWitness: {
        dev: snapshot.dev,
        ino: snapshot.ino,
        mtimeMs: snapshot.mtimeMs,
        size: snapshot.size,
        sanitizedContentHash: createHash("sha256").update(prepared.sanitizedJsonl).digest("hex"),
      },
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

export async function createLegacyAuditBackupCapture(params: {
  stateDir: string;
  tempDir: string;
}): Promise<LegacyAuditBackupCapture> {
  const snapshots = await createLegacyAuditBackupSnapshots(params);
  const databaseWitness = await readLegacyAuditDatabaseWitness(params.stateDir);
  return { snapshots, databaseWitness };
}

async function createLegacyAuditBackupSnapshots(params: {
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
