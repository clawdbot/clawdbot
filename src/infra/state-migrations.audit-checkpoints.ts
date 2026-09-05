import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createSqliteAuditRecordStore } from "./sqlite-audit-record-store.js";
import type {
  LegacyAuditLogSource,
  LegacyAuditLogsDetection,
} from "./state-migrations.audit-logs.types.js";

export type LegacyAuditFileCheckpoint = {
  dev: number;
  ino: number;
  mtimeMs: number;
  size: number;
};

export type LegacyAuditRawCheckpoint = LegacyAuditFileCheckpoint & {
  phase: "merge-intent" | "raw";
  generationKey: string;
  recordCount: number;
  recordOrdinalBase: number;
  contentHash: string;
  sanitizedContentHash: string;
  sanitizedSize: number;
};

const LEGACY_AUDIT_RAW_CHECKPOINT_SCOPE = "migration.legacy-audit-raw";
const LEGACY_AUDIT_RAW_CHECKPOINT_MAX_ENTRIES = 10_000;

export function legacyAuditRawCheckpointKey(checkpoint: LegacyAuditRawCheckpoint): string {
  return checkpoint.generationKey;
}

export function legacyAuditSourceGenerationKey(rawArchiveRelativePath: string): string {
  // The numbered raw archive path is the durable generation identity. Unlike
  // device/inode metadata, it survives backup restore and cross-device moves.
  return createHash("sha256")
    .update(rawArchiveRelativePath.replace(/\\/gu, "/"))
    .digest("hex")
    .slice(0, 16);
}

export function openLegacyAuditRawCheckpointStore(stateDir: string) {
  return createSqliteAuditRecordStore<LegacyAuditRawCheckpoint>({
    scope: LEGACY_AUDIT_RAW_CHECKPOINT_SCOPE,
    maxEntries: LEGACY_AUDIT_RAW_CHECKPOINT_MAX_ENTRIES,
    env: { ...process.env, OPENCLAW_STATE_DIR: stateDir },
  });
}

export function hasLegacyAuditRawCheckpointCapacity(
  stateDir: string,
  rawArchiveRelativePath: string,
): boolean {
  const generationKey = legacyAuditSourceGenerationKey(rawArchiveRelativePath);
  const entries = openLegacyAuditRawCheckpointStore(stateDir).entries();
  return (
    entries.some((entry) => entry.value.generationKey === generationKey) ||
    entries.length < LEGACY_AUDIT_RAW_CHECKPOINT_MAX_ENTRIES
  );
}

function statLegacyAuditRawCheckpoint(sourcePath: string): LegacyAuditFileCheckpoint | undefined {
  try {
    const stat = fs.lstatSync(sourcePath);
    if (!stat.isFile() || stat.isSymbolicLink()) {
      return undefined;
    }
    return { dev: stat.dev, ino: stat.ino, mtimeMs: stat.mtimeMs, size: stat.size };
  } catch {
    return undefined;
  }
}

export function legacyAuditRawCheckpointsMatch(
  left: LegacyAuditFileCheckpoint | undefined,
  right: LegacyAuditFileCheckpoint | undefined,
): boolean {
  return (
    left !== undefined &&
    right !== undefined &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mtimeMs === right.mtimeMs &&
    left.size === right.size
  );
}

function legacyAuditRawCheckpointIsCurrent(
  sourcePath: string,
  checkpoint: LegacyAuditRawCheckpoint,
): boolean {
  let fd: number | undefined;
  try {
    fd = fs.openSync(sourcePath, "r");
    const beforeStat = fs.fstatSync(fd);
    const before = {
      dev: beforeStat.dev,
      ino: beforeStat.ino,
      mtimeMs: beforeStat.mtimeMs,
      size: beforeStat.size,
    };
    if (!beforeStat.isFile() || !legacyAuditRawCheckpointsMatch(checkpoint, before)) {
      return false;
    }
    const hash = createHash("sha256");
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let offset = 0;
    while (offset < checkpoint.size) {
      const bytesRead = fs.readSync(
        fd,
        chunk,
        0,
        Math.min(chunk.byteLength, checkpoint.size - offset),
        offset,
      );
      if (bytesRead === 0) {
        return false;
      }
      hash.update(chunk.subarray(0, bytesRead));
      offset += bytesRead;
    }
    const afterStat = fs.fstatSync(fd);
    const after = {
      dev: afterStat.dev,
      ino: afterStat.ino,
      mtimeMs: afterStat.mtimeMs,
      size: afterStat.size,
    };
    return (
      legacyAuditRawCheckpointsMatch(before, after) &&
      offset === checkpoint.size &&
      hash.digest("hex") === checkpoint.contentHash
    );
  } catch {
    return false;
  } finally {
    if (fd !== undefined) {
      fs.closeSync(fd);
    }
  }
}

export function detectLegacyAuditLogs(params: {
  stateDir: string;
  doctorOnlyStateMigrations?: boolean;
}): LegacyAuditLogsDetection {
  const logicalSources: Array<Pick<LegacyAuditLogSource, "kind" | "label" | "sourcePath">> = [
    {
      kind: "config",
      label: "config audit log",
      sourcePath: path.join(params.stateDir, "logs", "config-audit.jsonl"),
    },
    {
      kind: "system-agent",
      label: "system-agent audit log",
      sourcePath: path.join(params.stateDir, "audit", "system-agent.jsonl"),
    },
    {
      kind: "crestodian",
      label: "Crestodian audit log",
      sourcePath: path.join(params.stateDir, "audit", "crestodian.jsonl"),
    },
  ];
  // Startup migrates every detected source. Retired audit imports belong only
  // to explicit `doctor --fix` repair.
  if (params.doctorOnlyStateMigrations !== true) {
    return { sources: [], hasLegacy: false };
  }
  let checkpoints: LegacyAuditRawCheckpoint[] | undefined;
  const loadCheckpoints = () => {
    if (checkpoints) {
      return checkpoints;
    }
    try {
      checkpoints = openLegacyAuditRawCheckpointStore(params.stateDir)
        .entries()
        .map((entry) => entry.value);
    } catch {
      checkpoints = [];
    }
    return checkpoints;
  };
  const sources: LegacyAuditLogSource[] = [];
  for (const logical of logicalSources) {
    let directoryEntries: string[] = [];
    try {
      directoryEntries = fs.readdirSync(path.dirname(logical.sourcePath));
    } catch {
      // The active-path check below still preserves the ordinary detection result.
    }
    const baseName = path.basename(logical.sourcePath).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const rawArchivePattern = new RegExp(
      `^${baseName}\\.migrated(?:\\.([2-9]|[1-9][0-9]+))?\\.raw$`,
      "u",
    );
    const claimPattern = new RegExp(
      `^\\.${baseName}\\.doctor-importing(?:\\.([2-9]|[1-9][0-9]+))?$`,
      "u",
    );
    const rawArchives = directoryEntries
      .flatMap((entry) => {
        const match = rawArchivePattern.exec(entry);
        return match ? [{ entry, generation: BigInt(match[1] ?? "1") }] : [];
      })
      .toSorted(
        (left, right) =>
          (left.generation < right.generation ? -1 : left.generation > right.generation ? 1 : 0) ||
          left.entry.localeCompare(right.entry),
      );
    for (const { entry } of rawArchives) {
      const rawPath = path.join(path.dirname(logical.sourcePath), entry);
      const rawRelativePath = path.relative(path.resolve(params.stateDir), rawPath);
      const generationKey = legacyAuditSourceGenerationKey(rawRelativePath);
      const checkpoint = statLegacyAuditRawCheckpoint(rawPath);
      const hasRecoveryJournal =
        statLegacyAuditRawCheckpoint(`${rawPath}.doctor-scrub-restore`) !== undefined;
      if (
        !hasRecoveryJournal &&
        checkpoint &&
        loadCheckpoints().some(
          (candidate) =>
            candidate.generationKey === generationKey &&
            candidate.phase === "raw" &&
            candidate.recordCount === 0 &&
            legacyAuditRawCheckpointsMatch(candidate, checkpoint) &&
            legacyAuditRawCheckpointIsCurrent(rawPath, candidate),
        )
      ) {
        continue;
      }
      sources.push({
        ...logical,
        sourcePath: rawPath,
        logicalSourcePath: logical.sourcePath,
        storage: "raw-archive",
        sanitizedArchivePath: rawPath.slice(0, -".raw".length),
      });
    }
    // Claims reserve their archive generation across a crash. An older
    // sanitized-only generation cannot be reused by a later claim.
    const claims = directoryEntries
      .flatMap((entry) => {
        const match = claimPattern.exec(entry);
        return match ? [{ entry, generation: BigInt(match[1] ?? "1") }] : [];
      })
      .toSorted(
        (left, right) =>
          (left.generation < right.generation ? -1 : left.generation > right.generation ? 1 : 0) ||
          left.entry.localeCompare(right.entry),
      );
    for (const { entry, generation } of claims) {
      const generationSuffix = generation === 1n ? "" : `.${generation}`;
      const sanitizedArchivePath = `${logical.sourcePath}.migrated${generationSuffix}`;
      sources.push({
        ...logical,
        sourcePath: path.join(path.dirname(logical.sourcePath), entry),
        logicalSourcePath: logical.sourcePath,
        storage: "claim",
        sanitizedArchivePath,
        rawArchivePath: `${sanitizedArchivePath}.raw`,
      });
    }
    if (fs.existsSync(logical.sourcePath)) {
      sources.push({
        ...logical,
        logicalSourcePath: logical.sourcePath,
        storage: "active",
      });
    }
  }
  return { sources, hasLegacy: sources.length > 0 };
}
