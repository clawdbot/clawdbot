// Legacy cron JSON/state store loader and archiver for doctor migration.
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { isRecord } from "../../../../packages/normalization-core/src/record-coerce.js";
import {
  normalizeOptionalString,
  normalizeOptionalStringifiedId,
} from "../../../../packages/normalization-core/src/string-coerce.js";
import { coerceFiniteScheduleNumber } from "../../../cron/schedule-number.js";
import { normalizeCronStaggerMs } from "../../../cron/stagger.js";
import type {
  CronConfigJobRuntimeEntry,
  LoadedCronStore,
  QuarantinedCronConfigJob,
} from "../../../cron/store.js";
import type { CronStoreFile } from "../../../cron/types.js";
import { parseJsonWithJson5Fallback } from "../../../utils/parse-json-compat.js";

const LEGACY_CRON_ARCHIVE_SUFFIX = ".migrated";
const legacyCronMigrationIds = new WeakMap<Record<string, unknown>, string>();

export function resolveLegacyCronMigrationId(job: Record<string, unknown>): string | undefined {
  return legacyCronMigrationIds.get(job);
}

function markLegacyCronMigrationIdentity(job: Record<string, unknown>, sourceIndex: number): void {
  if (normalizeOptionalStringifiedId(job.id) ?? normalizeOptionalStringifiedId(job.jobId)) {
    return;
  }
  const digest = createHash("sha256").update(JSON.stringify(job)).digest("hex");
  legacyCronMigrationIds.set(job, `cron-migrated-${sourceIndex}-${digest}`);
}

function resolveLegacyCronStatePath(storePath: string): string {
  if (storePath.endsWith(".json")) {
    return storePath.replace(/\.json$/, "-state.json");
  }
  return `${storePath}-state.json`;
}

export type LegacyCronMigrationSource = {
  sourceKey: string;
  sourcePath: string;
  sourceSha256: string;
  statePath: string;
  stateSha256?: string;
  sourceSizeBytes: number;
  sourceRecordCount: number;
};

function createLegacyCronMigrationSource(params: {
  sourcePath: string;
  raw: string;
  statePath: string;
  stateRaw?: string;
  recordCount: number;
}): LegacyCronMigrationSource {
  const sourceSha256 = createHash("sha256").update(params.raw).digest("hex");
  const stateSha256 =
    params.stateRaw !== undefined
      ? createHash("sha256").update(params.stateRaw).digest("hex")
      : undefined;
  const sourceKeyHash = createHash("sha256")
    .update(`${params.sourcePath}\0${sourceSha256}\0${stateSha256 ?? ""}`)
    .digest("hex");
  return {
    sourceKey: `cron-json:${sourceKeyHash}`,
    sourcePath: params.sourcePath,
    sourceSha256,
    statePath: params.statePath,
    stateSha256,
    sourceSizeBytes: Buffer.byteLength(params.raw) + Buffer.byteLength(params.stateRaw ?? ""),
    sourceRecordCount: params.recordCount,
  };
}

async function legacyCronFileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw err;
  }
}

type ArchiveOutcome = { ok: true; archivePath?: string } | { ok: false; reason: string };

function formatArchiveError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isUnsupportedDirectorySyncError(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  if (code === "EINVAL" || code === "ENOTSUP" || code === "ENOSYS") {
    return true;
  }
  return (
    process.platform === "win32" && (code === "EISDIR" || code === "EPERM" || code === "EACCES")
  );
}

async function syncArchiveDirectory(dirPath: string): Promise<void> {
  let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
  try {
    handle = await fs.open(dirPath, "r");
    await handle.sync();
  } catch (err) {
    if (!isUnsupportedDirectorySyncError(err)) {
      throw err;
    }
  } finally {
    await handle?.close();
  }
}

async function sha256File(filePath: string): Promise<string> {
  return createHash("sha256")
    .update(await fs.readFile(filePath))
    .digest("hex");
}

/** Refuse to persist a migration plan built from legacy files that changed after loading. */
export async function assertLegacyCronMigrationSourceCurrent(
  source: LegacyCronMigrationSource,
): Promise<void> {
  if ((await sha256File(source.sourcePath)) !== source.sourceSha256) {
    throw new Error("legacy cron source changed while doctor was preparing its migration");
  }
  if (source.stateSha256) {
    if ((await sha256File(source.statePath)) !== source.stateSha256) {
      throw new Error("legacy cron state changed while doctor was preparing its migration");
    }
  } else if (await legacyCronFileExists(source.statePath)) {
    throw new Error("legacy cron state appeared while doctor was preparing its migration");
  }
}

async function restoreArchivedSource(
  archivePath: string,
  sourcePath: string,
  expectedSha256?: string,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  try {
    if (await legacyCronFileExists(sourcePath)) {
      return {
        ok: false,
        reason: `archive remains at ${archivePath} because a new source exists at ${sourcePath}`,
      };
    }
  } catch (err) {
    return {
      ok: false,
      reason: `archive remains at ${archivePath} because the source path could not be checked: ${formatArchiveError(err)}`,
    };
  }
  try {
    await fs.rename(archivePath, sourcePath);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EXDEV") {
      const outcome = await copyLegacyCronFileAcrossDevices(
        archivePath,
        sourcePath,
        expectedSha256,
        false,
      );
      return outcome.ok ? { ok: true } : outcome;
    }
    return {
      ok: false,
      reason: `archive remains at ${archivePath} because restoration failed: ${formatArchiveError(err)}`,
    };
  }
  try {
    await syncArchiveDirectory(path.dirname(sourcePath));
    return { ok: true };
  } catch (err) {
    return {
      ok: false,
      reason: `the source was restored, but rollback directory sync failed: ${formatArchiveError(err)}`,
    };
  }
}

async function copyLegacyCronFileAcrossDevices(
  filePath: string,
  initialArchivePath: string,
  expectedSha256?: string,
  useNumberedArchive = true,
): Promise<ArchiveOutcome> {
  let archivePath = initialArchivePath;
  let archiveCreated = false;
  let sourceRemoved = false;
  try {
    const sourceStat = await fs.stat(filePath);
    if (!sourceStat.isFile()) {
      throw new Error("legacy cron source is not a regular file");
    }
    if (expectedSha256 && (await sha256File(filePath)) !== expectedSha256) {
      throw new Error("legacy cron source changed after it was imported; refusing to archive it");
    }
    const sourceMode = sourceStat.mode & 0o777;
    for (let index = 2; ; index += 1) {
      try {
        const archiveHandle = await fs.open(archivePath, "wx", sourceMode | 0o600);
        archiveCreated = true;
        await archiveHandle.close();
        break;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST" || !useNumberedArchive) {
          throw err;
        }
        archivePath = `${filePath}${LEGACY_CRON_ARCHIVE_SUFFIX}.${index}`;
      }
    }

    // Claim the destination before copyFile so any partial output from a failed,
    // non-atomic copy is owned by this attempt and removed by the catch path.
    await fs.copyFile(filePath, archivePath);
    if (expectedSha256 && (await sha256File(archivePath)) !== expectedSha256) {
      throw new Error("copied legacy cron archive does not match the imported source");
    }
    await fs.chmod(archivePath, sourceMode | 0o600);
    const archiveHandle = await fs.open(archivePath, "r+");
    try {
      await archiveHandle.chmod(sourceMode);
      await archiveHandle.utimes(sourceStat.atime, sourceStat.mtime);
      await archiveHandle.sync();
    } finally {
      await archiveHandle.close();
    }
    await syncArchiveDirectory(path.dirname(archivePath));
    const currentSourceStat = await fs.stat(filePath);
    if (
      currentSourceStat.dev !== sourceStat.dev ||
      currentSourceStat.ino !== sourceStat.ino ||
      (expectedSha256 && (await sha256File(filePath)) !== expectedSha256)
    ) {
      throw new Error("legacy cron source changed during archival; refusing to remove it");
    }
    // Current OpenClaw runtime never writes legacy JSON. POSIX has no conditional
    // unlink, so hashes close observed external edits before migration-owned removal.
    await fs.unlink(filePath);
    sourceRemoved = true;
    await syncArchiveDirectory(path.dirname(filePath));
    return { ok: true, archivePath };
  } catch (err) {
    if (sourceRemoved) {
      return {
        ok: false,
        reason: `${formatArchiveError(err)}; the durable archive is preserved at ${archivePath} because the source was already removed`,
      };
    }
    const cleanupFailures: string[] = [];
    if (archiveCreated) {
      let archiveRemoved = false;
      try {
        try {
          await fs.unlink(archivePath);
        } catch (cleanupErr) {
          if ((cleanupErr as NodeJS.ErrnoException).code !== "ENOENT") {
            throw cleanupErr;
          }
        }
        archiveRemoved = true;
        await syncArchiveDirectory(path.dirname(archivePath));
      } catch (cleanupErr) {
        cleanupFailures.push(
          archiveRemoved
            ? `the partial archive was removed, but cleanup directory sync failed: ${formatArchiveError(cleanupErr)}`
            : `partial archive remains at ${archivePath} because cleanup failed: ${formatArchiveError(cleanupErr)}`,
        );
      }
    }
    const cleanupReason = cleanupFailures.length > 0 ? `; ${cleanupFailures.join("; ")}` : "";
    return { ok: false, reason: `${formatArchiveError(err)}${cleanupReason}` };
  }
}

async function archiveLegacyCronFile(
  filePath: string,
  expectedSha256?: string,
): Promise<ArchiveOutcome> {
  let archivePath = `${filePath}${LEGACY_CRON_ARCHIVE_SUFFIX}`;
  try {
    if (!(await legacyCronFileExists(filePath))) {
      return { ok: true };
    }
    for (let index = 2; await legacyCronFileExists(archivePath); index += 1) {
      archivePath = `${filePath}${LEGACY_CRON_ARCHIVE_SUFFIX}.${index}`;
    }
  } catch (err) {
    return { ok: false, reason: formatArchiveError(err) };
  }

  try {
    await fs.rename(filePath, archivePath);
  } catch (err) {
    // A cross-device rename can occur when the configured store is a mounted file.
    // Fsync before source removal and roll back failed cleanup so retries stay idempotent.
    if ((err as { code?: unknown })?.code !== "EXDEV") {
      return { ok: false, reason: formatArchiveError(err) };
    }
    return await copyLegacyCronFileAcrossDevices(filePath, archivePath, expectedSha256);
  }

  try {
    if (expectedSha256 && (await sha256File(archivePath)) !== expectedSha256) {
      throw new Error("legacy cron source changed after it was imported; refusing to archive it");
    }
    await syncArchiveDirectory(path.dirname(filePath));
    if (await legacyCronFileExists(filePath)) {
      return {
        ok: false,
        reason: `the imported source was archived, but a new legacy cron source now exists at ${filePath}`,
      };
    }
    return { ok: true, archivePath };
  } catch (err) {
    const restoreFailure = await restoreArchivedSource(archivePath, filePath, expectedSha256);
    return {
      ok: false,
      reason: restoreFailure.ok
        ? formatArchiveError(err)
        : `${formatArchiveError(err)}; ${restoreFailure.reason}`,
    };
  }
}

function parseCronStateFile(raw: string): {
  version: 1;
  jobs: Record<string, CronConfigJobRuntimeEntry>;
} | null {
  try {
    const parsed = parseJsonWithJson5Fallback(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    if (
      record.version !== 1 ||
      typeof record.jobs !== "object" ||
      record.jobs === null ||
      Array.isArray(record.jobs)
    ) {
      return null;
    }
    return {
      version: 1,
      jobs: record.jobs as Record<string, CronConfigJobRuntimeEntry>,
    };
  } catch {
    return null;
  }
}

function readString(record: Record<string, unknown>, key: string): string | undefined {
  return normalizeOptionalString(record[key]);
}

function readNumber(record: Record<string, unknown>, key: string): number | undefined {
  return coerceFiniteScheduleNumber(record[key]);
}

function legacySchedulePayloadFromRecord(
  schedule: Record<string, unknown>,
):
  | { kind: "at"; at: string }
  | { kind: "every"; everyMs: number; anchorMs?: number }
  | { kind: "cron"; expr: string; tz?: string; staggerMs?: number }
  | undefined {
  const rawKind = readString(schedule, "kind")?.toLowerCase();
  const expr = readString(schedule, "expr") ?? readString(schedule, "cron");
  const at = readString(schedule, "at");
  const atMs = readNumber(schedule, "atMs");
  const everyMs = readNumber(schedule, "everyMs");
  const anchorMs = readNumber(schedule, "anchorMs");
  const tz = readString(schedule, "tz");
  const staggerMs = normalizeCronStaggerMs(schedule.staggerMs);
  const kind =
    rawKind === "at" || rawKind === "every" || rawKind === "cron"
      ? rawKind
      : at || atMs !== undefined
        ? "at"
        : everyMs !== undefined
          ? "every"
          : expr
            ? "cron"
            : undefined;

  if (kind === "at") {
    return at
      ? { kind: "at", at }
      : atMs !== undefined
        ? { kind: "at", at: String(atMs) }
        : undefined;
  }
  if (kind === "every" && everyMs !== undefined) {
    return { kind: "every", everyMs, anchorMs };
  }
  if (kind === "cron" && expr) {
    return { kind: "cron", expr, tz, staggerMs };
  }
  return undefined;
}

function tryLegacyCronScheduleIdentity(job: Record<string, unknown>): string | undefined {
  const schedule =
    job.schedule && typeof job.schedule === "object" && !Array.isArray(job.schedule)
      ? legacySchedulePayloadFromRecord(job.schedule as Record<string, unknown>)
      : legacySchedulePayloadFromRecord(job);
  if (!schedule) {
    return undefined;
  }
  return JSON.stringify({
    version: 1,
    enabled: typeof job.enabled === "boolean" ? job.enabled : true,
    schedule,
  });
}

function getRawCronJobs(parsed: unknown): unknown[] {
  return Array.isArray(parsed)
    ? parsed
    : isRecord(parsed) && Array.isArray(parsed.jobs)
      ? parsed.jobs
      : [];
}

function cloneConfigJobs(jobs: Array<Record<string, unknown>>): Array<Record<string, unknown>> {
  return jobs.map((job) => structuredClone(job));
}

async function loadStateFile(statePath: string): Promise<{
  state: { version: 1; jobs: Record<string, CronConfigJobRuntimeEntry> } | null;
  raw?: string;
}> {
  let raw: string;
  try {
    raw = await fs.readFile(statePath, "utf-8");
  } catch (err) {
    if ((err as { code?: unknown })?.code === "ENOENT") {
      return { state: null };
    }
    throw new Error(`Failed to read cron state at ${statePath}: ${String(err)}`, {
      cause: err,
    });
  }

  return { state: parseCronStateFile(raw), raw };
}

function hasInlineState(jobs: Array<Record<string, unknown> | null | undefined>): boolean {
  return jobs.some(
    (job) => job != null && isRecord(job.state) && Object.keys(job.state).length > 0,
  );
}

function ensureJobStateObject(job: CronStoreFile["jobs"][number]): void {
  if (!isRecord(job.state)) {
    job.state = {} as never;
  }
}

function backfillMissingRuntimeFields(job: CronStoreFile["jobs"][number]): void {
  ensureJobStateObject(job);
  if (typeof job.updatedAtMs !== "number") {
    job.updatedAtMs = typeof job.createdAtMs === "number" ? job.createdAtMs : Date.now();
  }
}

function resolveUpdatedAtMs(job: CronStoreFile["jobs"][number], updatedAtMs: unknown): number {
  if (typeof updatedAtMs === "number" && Number.isFinite(updatedAtMs)) {
    return updatedAtMs;
  }
  if (typeof job.updatedAtMs === "number" && Number.isFinite(job.updatedAtMs)) {
    return job.updatedAtMs;
  }
  return typeof job.createdAtMs === "number" && Number.isFinite(job.createdAtMs)
    ? job.createdAtMs
    : Date.now();
}

function mergeStateFileEntry(job: CronStoreFile["jobs"][number], entry: unknown): void {
  if (!isRecord(entry)) {
    backfillMissingRuntimeFields(job);
    return;
  }
  job.updatedAtMs = resolveUpdatedAtMs(job, entry.updatedAtMs);
  job.state = isRecord(entry.state) ? (entry.state as never) : ({} as never);
  if (
    typeof entry.scheduleIdentity === "string" &&
    entry.scheduleIdentity !==
      tryLegacyCronScheduleIdentity(job as unknown as Record<string, unknown>)
  ) {
    ensureJobStateObject(job);
    job.state.nextRunAtMs = undefined;
  }
}

function resolveCronStateId(job: Record<string, unknown>): string | undefined {
  return normalizeOptionalString(job.id) ?? normalizeOptionalString(job.jobId);
}

/** Return true when legacy cron JSON or state files exist for a store path. */
export async function legacyCronStoreFilesExist(storePath: string): Promise<boolean> {
  const resolvedStorePath = path.resolve(storePath);
  return (
    (await legacyCronFileExists(resolvedStorePath)) ||
    (await legacyCronFileExists(resolveLegacyCronStatePath(resolvedStorePath)))
  );
}

type LegacyCronArchiveResult =
  | { ok: true }
  | { ok: false; failures: Array<{ path: string; reason: string }> };

/** Archive legacy cron JSON/state files after successful migration. */
export async function archiveLegacyCronStoreForMigration(
  storePath: string,
  source?: LegacyCronMigrationSource,
): Promise<LegacyCronArchiveResult> {
  const resolvedStorePath = path.resolve(storePath);
  const statePath = resolveLegacyCronStatePath(resolvedStorePath);
  const failures: Array<{ path: string; reason: string }> = [];
  const archived: Array<{ path: string; archivePath: string; sha256?: string }> = [];
  const rollbackArchived = async (): Promise<void> => {
    for (const target of archived.toReversed()) {
      const outcome = await restoreArchivedSource(target.archivePath, target.path, target.sha256);
      if (!outcome.ok) {
        failures.push({ path: target.path, reason: `archive rollback failed: ${outcome.reason}` });
      }
    }
  };
  const unexpectedStateReason = async (): Promise<string | undefined> => {
    try {
      return (await legacyCronFileExists(statePath))
        ? "legacy cron state appeared after the store was imported; refusing to archive it"
        : undefined;
    } catch (err) {
      return `legacy cron state path could not be checked: ${formatArchiveError(err)}`;
    }
  };

  if (source && !source.stateSha256) {
    const reason = await unexpectedStateReason();
    if (reason) {
      return { ok: false, failures: [{ path: statePath, reason }] };
    }
  }

  // State is archived first so the primary JSON source remains retryable until
  // every byte already persisted in SQLite has a durable archive.
  const targets: Array<{ path: string; sha256?: string }> = source
    ? [
        ...(source.stateSha256 ? [{ path: statePath, sha256: source.stateSha256 }] : []),
        { path: resolvedStorePath, sha256: source.sourceSha256 },
      ]
    : [{ path: statePath }, { path: resolvedStorePath }];
  for (const target of targets) {
    const outcome = await archiveLegacyCronFile(target.path, target.sha256);
    if (!outcome.ok) {
      failures.push({ path: target.path, reason: outcome.reason });
      await rollbackArchived();
      break;
    }
    if (outcome.archivePath) {
      archived.push({ ...target, archivePath: outcome.archivePath });
    }
  }
  if (failures.length === 0 && source) {
    const reason = await unexpectedStateReason();
    if (reason) {
      failures.push({ path: statePath, reason });
      await rollbackArchived();
    }
  }
  return failures.length === 0 ? { ok: true } : { ok: false, failures };
}

/** Load legacy cron JSON/state files into the current loaded-store shape for migration. */
export async function loadLegacyCronStoreForMigration(
  storePath: string,
): Promise<LoadedCronStore & { migrationSource?: LegacyCronMigrationSource }> {
  const resolvedStorePath = path.resolve(storePath);
  try {
    const raw = await fs.readFile(resolvedStorePath, "utf-8");
    let parsed: unknown;
    try {
      parsed = parseJsonWithJson5Fallback(raw);
    } catch (err) {
      throw new Error(`Failed to parse cron store at ${resolvedStorePath}: ${String(err)}`, {
        cause: err,
      });
    }
    const rawJobs = getRawCronJobs(parsed);
    const configJobIndexes: number[] = [];
    const configRows: Array<Record<string, unknown>> = [];
    const configJobRuntimeEntries: CronConfigJobRuntimeEntry[] = [];
    const invalidConfigRows: QuarantinedCronConfigJob[] = [];
    for (const [index, row] of rawJobs.entries()) {
      if (isRecord(row)) {
        // The source position distinguishes identical id-less rows, while the raw digest
        // prevents an edited retry from being mistaken for the row previously imported.
        markLegacyCronMigrationIdentity(row, index);
        configJobIndexes.push(index);
        configRows.push(row);
      } else {
        invalidConfigRows.push({
          sourceIndex: index,
          reason: "non-object-row",
          raw: structuredClone(row),
        });
      }
    }
    const store: CronStoreFile = {
      version: 1,
      jobs: configRows as never as CronStoreFile["jobs"],
    };
    const jobs = store.jobs as unknown as Array<Record<string, unknown>>;
    const configJobs = cloneConfigJobs(configRows);

    const statePath = resolveLegacyCronStatePath(resolvedStorePath);
    const loadedStateFile = await loadStateFile(statePath);
    const stateFile = loadedStateFile.state;
    const hasLegacyInlineState = !stateFile && hasInlineState(jobs);

    if (stateFile) {
      for (const job of store.jobs) {
        const stateId = resolveCronStateId(job as unknown as Record<string, unknown>);
        const entry = stateId ? stateFile.jobs[stateId] : undefined;
        configJobRuntimeEntries.push(isRecord(entry) ? structuredClone(entry) : {});
        if (entry) {
          mergeStateFileEntry(job, entry);
        } else {
          backfillMissingRuntimeFields(job);
        }
      }
    } else if (!hasLegacyInlineState) {
      for (const job of store.jobs) {
        backfillMissingRuntimeFields(job);
      }
    }

    for (const job of store.jobs) {
      ensureJobStateObject(job);
    }

    return {
      store,
      configJobs,
      configJobIndexes,
      configJobRuntimeEntries,
      invalidConfigRows,
      migrationSource: createLegacyCronMigrationSource({
        sourcePath: resolvedStorePath,
        raw,
        statePath,
        stateRaw: loadedStateFile.raw,
        recordCount: rawJobs.length,
      }),
    };
  } catch (err) {
    if ((err as { code?: unknown })?.code === "ENOENT") {
      return {
        store: { version: 1, jobs: [] },
        configJobs: [],
        configJobIndexes: [],
        configJobRuntimeEntries: [],
        invalidConfigRows: [],
      };
    }
    throw err;
  }
}
