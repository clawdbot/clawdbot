import fs from "node:fs";
import path from "node:path";
import { expandHomePrefix } from "../infra/home-dir.js";
import { replaceFileAtomic } from "../infra/replace-file.js";
import { isRecord } from "../shared/record-coerce.js";
import { normalizeOptionalString } from "../shared/string-coerce.js";
import { resolveConfigDir } from "../utils.js";
import { parseJsonWithJson5Fallback } from "../utils/parse-json-compat.js";
import { tryCronScheduleIdentity } from "./schedule-identity.js";
import type { CronStoreFile } from "./types.js";

type SerializedStoreCacheEntry = {
  configJson?: string;
  stateJson?: string;
  needsSplitMigration: boolean;
};

export type QuarantinedCronConfigJob = {
  sourceIndex: number;
  reason: string;
  job?: Record<string, unknown>;
  raw?: unknown;
  state?: Record<string, unknown>;
  updatedAtMs?: number;
  scheduleIdentity?: string;
};

export type CronQuarantineFile = {
  version: 1;
  jobs: Array<QuarantinedCronConfigJob & { quarantinedAtMs: number }>;
};

export type LoadedCronStore = {
  store: CronStoreFile;
  configJobs: Array<Record<string, unknown>>;
  configJobIndexes: number[];
  configJobRuntimeEntries: CronConfigJobRuntimeEntry[];
  invalidConfigRows: QuarantinedCronConfigJob[];
};

const serializedStoreCache = new Map<string, SerializedStoreCacheEntry>();

function getSerializedStoreCache(storePath: string): SerializedStoreCacheEntry {
  let entry = serializedStoreCache.get(storePath);
  if (!entry) {
    entry = { needsSplitMigration: false };
    serializedStoreCache.set(storePath, entry);
  }
  return entry;
}

function resolveDefaultCronDir(): string {
  return path.join(resolveConfigDir(), "cron");
}

function resolveDefaultCronStorePath(): string {
  return path.join(resolveDefaultCronDir(), "jobs.json");
}

function resolveStatePath(storePath: string): string {
  if (storePath.endsWith(".json")) {
    return storePath.replace(/\.json$/, "-state.json");
  }
  return `${storePath}-state.json`;
}

export function resolveCronQuarantinePath(storePath: string): string {
  if (storePath.endsWith(".json")) {
    return storePath.replace(/\.json$/, "-quarantine.json");
  }
  return `${storePath}-quarantine.json`;
}

type CronStateFileEntry = {
  updatedAtMs?: number;
  scheduleIdentity?: string;
  state?: Record<string, unknown>;
};

export type CronConfigJobRuntimeEntry = CronStateFileEntry;

type CronStateFile = {
  version: 1;
  jobs: Record<string, CronStateFileEntry>;
};

function parseCronStateFile(raw: string): CronStateFile | null {
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
    return { version: 1, jobs: record.jobs as Record<string, CronStateFileEntry> };
  } catch {
    return null;
  }
}

function normalizeCronStoreFile(parsed: unknown): CronStoreFile {
  const rawJobs = getRawCronJobs(parsed);
  return {
    version: 1,
    jobs: rawJobs.filter(isRecord) as never as CronStoreFile["jobs"],
  };
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

function stripJobRuntimeFields(job: CronStoreFile["jobs"][number]): Record<string, unknown> {
  const { state: _state, updatedAtMs: _updatedAtMs, ...rest } = job;
  return { ...rest, state: {} };
}

function stripRuntimeOnlyCronFields(store: CronStoreFile): unknown {
  const jobs = store.jobs.map(stripJobRuntimeFields);
  return {
    version: store.version,
    jobs,
  };
}

function extractStateFile(store: CronStoreFile): CronStateFile {
  const jobs: Record<string, CronStateFileEntry> = {};
  for (const job of store.jobs) {
    jobs[job.id] = {
      updatedAtMs: job.updatedAtMs,
      scheduleIdentity: tryCronScheduleIdentity(job as unknown as Record<string, unknown>),
      state: job.state ?? {},
    };
  }
  return { version: 1, jobs };
}

export function resolveCronStorePath(storePath?: string) {
  if (storePath?.trim()) {
    const raw = storePath.trim();
    if (raw.startsWith("~")) {
      return path.resolve(expandHomePrefix(raw));
    }
    return path.resolve(raw);
  }
  return resolveDefaultCronStorePath();
}

async function loadStateFile(statePath: string): Promise<CronStateFile | null> {
  let raw: string;
  try {
    raw = await fs.promises.readFile(statePath, "utf-8");
  } catch (err) {
    if ((err as { code?: unknown })?.code === "ENOENT") {
      return null;
    }
    throw new Error(`Failed to read cron state at ${statePath}: ${String(err)}`, {
      cause: err,
    });
  }

  return parseCronStateFile(raw);
}

function loadStateFileSync(statePath: string): CronStateFile | null {
  let raw: string;
  try {
    raw = fs.readFileSync(statePath, "utf-8");
  } catch (err) {
    if ((err as { code?: unknown })?.code === "ENOENT") {
      return null;
    }
    throw new Error(`Failed to read cron state at ${statePath}: ${String(err)}`, {
      cause: err,
    });
  }

  return parseCronStateFile(raw);
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
    entry.scheduleIdentity !== tryCronScheduleIdentity(job as unknown as Record<string, unknown>)
  ) {
    ensureJobStateObject(job);
    job.state.nextRunAtMs = undefined;
  }
}

function resolveCronStateId(job: Record<string, unknown>): string | undefined {
  return normalizeOptionalString(job.id) ?? normalizeOptionalString(job.jobId);
}

export async function loadCronStoreWithConfigJobs(storePath: string): Promise<LoadedCronStore> {
  try {
    const raw = await fs.promises.readFile(storePath, "utf-8");
    let parsed: unknown;
    try {
      parsed = parseJsonWithJson5Fallback(raw);
    } catch (err) {
      throw new Error(`Failed to parse cron store at ${storePath}: ${String(err)}`, {
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

    // Load state file and merge.
    const statePath = resolveStatePath(storePath);
    const stateFile = await loadStateFile(statePath);
    const hasLegacyInlineState = !stateFile && hasInlineState(jobs);

    if (stateFile) {
      // State file exists: merge state by job ID. Inline state in jobs.json is ignored.
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
      // No state file, no inline state: fresh clone or first run.
      for (const job of store.jobs) {
        backfillMissingRuntimeFields(job);
      }
    }
    // else: migration mode — no state file but jobs.json has inline state. Use as-is.

    // Ensure every job has a state object (defensive).
    for (const job of store.jobs) {
      ensureJobStateObject(job);
    }

    const configJson = JSON.stringify(stripRuntimeOnlyCronFields(store), null, 2);
    const stateJson = JSON.stringify(extractStateFile(store), null, 2);
    serializedStoreCache.set(storePath, {
      configJson,
      stateJson,
      needsSplitMigration: hasLegacyInlineState,
    });

    return { store, configJobs, configJobIndexes, configJobRuntimeEntries, invalidConfigRows };
  } catch (err) {
    if ((err as { code?: unknown })?.code === "ENOENT") {
      serializedStoreCache.delete(storePath);
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

export async function loadCronStore(storePath: string): Promise<CronStoreFile> {
  return (await loadCronStoreWithConfigJobs(storePath)).store;
}

export function loadCronStoreSync(storePath: string): CronStoreFile {
  try {
    const raw = fs.readFileSync(storePath, "utf-8");
    let parsed: unknown;
    try {
      parsed = parseJsonWithJson5Fallback(raw);
    } catch (err) {
      throw new Error(`Failed to parse cron store at ${storePath}: ${String(err)}`, {
        cause: err,
      });
    }
    const store = normalizeCronStoreFile(parsed);
    const jobs = store.jobs as unknown as Array<Record<string, unknown>>;

    const stateFile = loadStateFileSync(resolveStatePath(storePath));
    const hasLegacyInlineState = !stateFile && hasInlineState(jobs);

    if (stateFile) {
      for (const job of store.jobs) {
        const stateId = resolveCronStateId(job as unknown as Record<string, unknown>);
        const entry = stateId ? stateFile.jobs[stateId] : undefined;
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

    return store;
  } catch (err) {
    if ((err as { code?: unknown })?.code === "ENOENT") {
      return { version: 1, jobs: [] };
    }
    throw err;
  }
}

type SaveCronStoreOptions = {
  skipBackup?: boolean;
  stateOnly?: boolean;
};

async function setSecureFileMode(filePath: string): Promise<void> {
  await fs.promises.chmod(filePath, 0o600).catch(() => undefined);
}

async function atomicWrite(filePath: string, content: string, dirMode = 0o700): Promise<void> {
  await replaceFileAtomic({
    filePath,
    content,
    dirMode,
    mode: 0o600,
    tempPrefix: ".openclaw-cron",
    renameMaxRetries: 3,
    copyFallbackOnPermissionError: true,
  });
}

async function serializedFileNeedsWrite(
  filePath: string,
  expectedJson: string,
  contentChanged: boolean,
): Promise<boolean> {
  if (contentChanged) {
    return true;
  }
  try {
    const diskJson = await fs.promises.readFile(filePath, "utf-8");
    return diskJson !== expectedJson;
  } catch (err) {
    if ((err as { code?: unknown })?.code === "ENOENT") {
      return true;
    }
    throw err;
  }
}

export async function saveCronStore(
  storePath: string,
  store: CronStoreFile,
  opts?: SaveCronStoreOptions,
) {
  const stateOnly = opts?.stateOnly === true;
  const configJson = JSON.stringify(stripRuntimeOnlyCronFields(store), null, 2);
  const stateFile = extractStateFile(store);
  const stateJson = JSON.stringify(stateFile, null, 2);

  const statePath = resolveStatePath(storePath);
  const cache = serializedStoreCache.get(storePath);

  const configChanged = !stateOnly && cache?.configJson !== configJson;
  const stateChanged = cache?.stateJson !== stateJson;
  const migrating = cache?.needsSplitMigration === true;
  const configNeedsWrite = stateOnly
    ? false
    : await serializedFileNeedsWrite(storePath, configJson, configChanged);
  const stateNeedsWrite = await serializedFileNeedsWrite(statePath, stateJson, stateChanged);

  if (
    stateOnly ? !stateNeedsWrite && !migrating : !configNeedsWrite && !stateNeedsWrite && !migrating
  ) {
    return;
  }

  const updatedCache = getSerializedStoreCache(storePath);

  // Write state first so migration never leaves stripped config without runtime state.
  if (stateNeedsWrite || migrating) {
    await atomicWrite(statePath, stateJson);
    updatedCache.stateJson = stateJson;
  }

  if (!stateOnly && (configNeedsWrite || migrating)) {
    // Determine backup need: only when config actually changed (not migration-only).
    const skipBackup = opts?.skipBackup === true || !configChanged;
    if (!skipBackup) {
      try {
        const backupPath = `${storePath}.bak`;
        await fs.promises.copyFile(storePath, backupPath);
        await setSecureFileMode(backupPath);
      } catch {
        // best-effort
      }
    }
    await atomicWrite(storePath, configJson);
    updatedCache.configJson = configJson;
  }
  updatedCache.needsSplitMigration = stateOnly && migrating;
}

export async function loadCronQuarantineFile(path: string): Promise<CronQuarantineFile> {
  try {
    const raw = await fs.promises.readFile(path, "utf-8");
    const parsed = parseJsonWithJson5Fallback(raw);
    if (!isRecord(parsed) || parsed.version !== 1 || !Array.isArray(parsed.jobs)) {
      throw new Error(`Unsupported cron quarantine file shape at ${path}`);
    }
    const jobs = parsed.jobs.map((entry, index) => {
      if (
        !isRecord(entry) ||
        typeof entry.reason !== "string" ||
        (!isRecord(entry.job) && !("raw" in entry))
      ) {
        throw new Error(`Unsupported cron quarantine entry at ${path} index ${index}`);
      }
      const sourceIndex = typeof entry.sourceIndex === "number" ? entry.sourceIndex : -1;
      const quarantinedAtMs =
        typeof entry.quarantinedAtMs === "number" && Number.isFinite(entry.quarantinedAtMs)
          ? entry.quarantinedAtMs
          : Date.now();
      const quarantined: CronQuarantineFile["jobs"][number] = {
        quarantinedAtMs,
        sourceIndex,
        reason: entry.reason,
      };
      if (isRecord(entry.job)) {
        quarantined.job = entry.job;
      }
      if ("raw" in entry) {
        quarantined.raw = entry.raw;
      }
      if (isRecord(entry.state)) {
        quarantined.state = entry.state;
      }
      if (typeof entry.updatedAtMs === "number" && Number.isFinite(entry.updatedAtMs)) {
        quarantined.updatedAtMs = entry.updatedAtMs;
      }
      if (typeof entry.scheduleIdentity === "string") {
        quarantined.scheduleIdentity = entry.scheduleIdentity;
      }
      return quarantined;
    });
    return { version: 1, jobs };
  } catch (err) {
    if ((err as { code?: unknown })?.code === "ENOENT") {
      return { version: 1, jobs: [] };
    }
    throw err;
  }
}

function quarantineEntryKey(entry: QuarantinedCronConfigJob): string {
  const rawId = entry.job
    ? (normalizeOptionalString(entry.job.id) ?? normalizeOptionalString(entry.job.jobId))
    : null;
  return JSON.stringify({
    id: rawId ?? null,
    sourceIndex: entry.sourceIndex,
    reason: entry.reason,
    job: entry.job ?? null,
    raw: entry.raw ?? null,
    state: entry.state ?? null,
    updatedAtMs: entry.updatedAtMs ?? null,
    scheduleIdentity: entry.scheduleIdentity ?? null,
  });
}

export async function saveCronQuarantineFile(params: {
  storePath: string;
  entries: QuarantinedCronConfigJob[];
  nowMs: number;
}) {
  if (params.entries.length === 0) {
    return null;
  }
  const quarantinePath = resolveCronQuarantinePath(params.storePath);
  const existing = await loadCronQuarantineFile(quarantinePath);
  const seen = new Set(existing.jobs.map(quarantineEntryKey));
  const nextJobs = existing.jobs.slice();
  let appended = false;
  for (const entry of params.entries.toSorted((a, b) => a.sourceIndex - b.sourceIndex)) {
    const key = quarantineEntryKey(entry);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    appended = true;
    nextJobs.push({
      quarantinedAtMs: params.nowMs,
      sourceIndex: entry.sourceIndex,
      reason: entry.reason,
      ...(entry.job ? { job: structuredClone(entry.job) } : {}),
      ...("raw" in entry ? { raw: structuredClone(entry.raw) } : {}),
      ...(entry.state ? { state: structuredClone(entry.state) } : {}),
      ...(entry.updatedAtMs !== undefined ? { updatedAtMs: entry.updatedAtMs } : {}),
      ...(entry.scheduleIdentity !== undefined ? { scheduleIdentity: entry.scheduleIdentity } : {}),
    });
  }
  if (!appended) {
    return quarantinePath;
  }
  const payload = JSON.stringify({ version: 1, jobs: nextJobs }, null, 2);
  await atomicWrite(quarantinePath, payload);
  return quarantinePath;
}
