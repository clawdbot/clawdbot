import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { expandHomePrefix } from "../infra/home-dir.js";
import { resolveConfigDir } from "../utils.js";
import { parseJsonWithJson5Fallback } from "../utils/parse-json-compat.js";
import type { CronStoreFile } from "./types.js";

type SerializedStoreCacheEntry = {
  configJson?: string;
  stateJson?: string;
  needsSplitMigration: boolean;
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

type CronStateFileEntry = {
  updatedAtMs?: number;
  state?: Record<string, unknown>;
};

type CronStateFile = {
  version: 1;
  jobs: Record<string, CronStateFileEntry>;
};

function stripRuntimeOnlyCronFields(store: CronStoreFile): unknown {
  return {
    version: store.version,
    jobs: store.jobs.map((job) => {
      const { state: _state, updatedAtMs: _updatedAtMs, ...rest } = job;
      return { ...rest, state: {} };
    }),
  };
}

function extractStateFile(store: CronStoreFile): CronStateFile {
  const jobs: Record<string, CronStateFileEntry> = {};
  for (const job of store.jobs) {
    jobs[job.id] = {
      updatedAtMs: job.updatedAtMs,
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
    // Best-effort: if state file is corrupt, treat as absent.
    return null;
  }
}

function hasInlineState(jobs: Array<Record<string, unknown> | null | undefined>): boolean {
  return jobs.some(
    (job) =>
      job != null &&
      job.state !== undefined &&
      typeof job.state === "object" &&
      job.state !== null &&
      Object.keys(job.state as Record<string, unknown>).length > 0,
  );
}

function ensureJobStateObject(job: CronStoreFile["jobs"][number]): void {
  if (!job.state || typeof job.state !== "object") {
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

export async function loadCronStore(storePath: string): Promise<CronStoreFile> {
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
    const parsedRecord =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    const jobs = Array.isArray(parsedRecord.jobs) ? (parsedRecord.jobs as never[]) : [];
    const store = {
      version: 1 as const,
      jobs: jobs.filter(Boolean) as never as CronStoreFile["jobs"],
    };

    // Load state file and merge.
    const statePath = resolveStatePath(storePath);
    const stateFile = await loadStateFile(statePath);
    const hasLegacyInlineState =
      !stateFile && hasInlineState(jobs as unknown as Array<Record<string, unknown>>);

    if (stateFile) {
      // State file exists: merge state by job ID. Inline state in jobs.json is ignored.
      for (const job of store.jobs) {
        const entry = stateFile.jobs[job.id];
        if (entry) {
          job.updatedAtMs = resolveUpdatedAtMs(job, entry.updatedAtMs);
          job.state = (entry.state ?? {}) as never;
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

    return store;
  } catch (err) {
    if ((err as { code?: unknown })?.code === "ENOENT") {
      serializedStoreCache.delete(storePath);
      return { version: 1, jobs: [] };
    }
    throw err;
  }
}

type SaveCronStoreOptions = {
  skipBackup?: boolean;
};

async function setSecureFileMode(filePath: string): Promise<void> {
  await fs.promises.chmod(filePath, 0o600).catch(() => undefined);
}

async function atomicWrite(filePath: string, content: string, dirMode = 0o700): Promise<void> {
  const dir = path.dirname(filePath);
  await fs.promises.mkdir(dir, { recursive: true, mode: dirMode });
  await fs.promises.chmod(dir, dirMode).catch(() => undefined);
  const tmp = `${filePath}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`;
  await fs.promises.writeFile(tmp, content, { encoding: "utf-8", mode: 0o600 });
  await renameWithRetry(tmp, filePath);
  await setSecureFileMode(filePath);
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
  const configJson = JSON.stringify(stripRuntimeOnlyCronFields(store), null, 2);
  const stateFile = extractStateFile(store);
  const stateJson = JSON.stringify(stateFile, null, 2);

  const statePath = resolveStatePath(storePath);
  const cache = serializedStoreCache.get(storePath);

  const configChanged = cache?.configJson !== configJson;
  const stateChanged = cache?.stateJson !== stateJson;
  const migrating = cache?.needsSplitMigration === true;
  const configNeedsWrite = await serializedFileNeedsWrite(storePath, configJson, configChanged);
  const stateNeedsWrite = await serializedFileNeedsWrite(statePath, stateJson, stateChanged);

  if (!configNeedsWrite && !stateNeedsWrite && !migrating) {
    return;
  }

  const updatedCache = getSerializedStoreCache(storePath);

  // Write state first so migration never leaves stripped config without runtime state.
  if (stateNeedsWrite || migrating) {
    await atomicWrite(statePath, stateJson);
    updatedCache.stateJson = stateJson;
  }

  if (configNeedsWrite || migrating) {
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
  updatedCache.needsSplitMigration = false;
}

const RENAME_MAX_RETRIES = 3;
const RENAME_BASE_DELAY_MS = 50;

async function renameWithRetry(src: string, dest: string): Promise<void> {
  for (let attempt = 0; attempt <= RENAME_MAX_RETRIES; attempt++) {
    try {
      await fs.promises.rename(src, dest);
      return;
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === "EBUSY" && attempt < RENAME_MAX_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, RENAME_BASE_DELAY_MS * 2 ** attempt));
        continue;
      }
      // Windows doesn't reliably support atomic replace via rename when dest exists.
      if (code === "EPERM" || code === "EEXIST") {
        await fs.promises.copyFile(src, dest);
        await fs.promises.unlink(src).catch(() => {});
        return;
      }
      throw err;
    }
  }
}
