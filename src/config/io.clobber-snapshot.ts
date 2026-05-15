import path from "node:path";

export const CONFIG_CLOBBER_SNAPSHOT_LIMIT = 32;

const CONFIG_CLOBBER_LOCK_STALE_MS = 30_000;
const CONFIG_CLOBBER_LOCK_RETRY_MS = 10;
const CONFIG_CLOBBER_LOCK_TIMEOUT_MS = 2_000;
const clobberCapWarnedPaths = new Set<string>();

type ConfigClobberSnapshotFs = {
  promises: {
    mkdir(path: string, options?: { recursive?: boolean; mode?: number }): Promise<unknown>;
    readdir(path: string): Promise<string[]>;
    rmdir(path: string): Promise<unknown>;
    stat(path: string): Promise<{ mtimeMs?: number } | null>;
    unlink(path: string): Promise<unknown>;
    writeFile(
      path: string,
      data: string,
      options?: { encoding?: BufferEncoding; mode?: number; flag?: string },
    ): Promise<unknown>;
  };
  mkdirSync(path: string, options?: { recursive?: boolean; mode?: number }): unknown;
  readdirSync(path: string): string[];
  rmdirSync(path: string): unknown;
  statSync(path: string, options?: { throwIfNoEntry?: boolean }): { mtimeMs?: number } | null;
  unlinkSync(path: string): unknown;
  writeFileSync(
    path: string,
    data: string,
    options?: { encoding?: BufferEncoding; mode?: number; flag?: string },
  ): unknown;
};

export type ConfigClobberSnapshotDeps = {
  fs: ConfigClobberSnapshotFs;
  logger: Pick<typeof console, "warn">;
};

function formatConfigArtifactTimestamp(ts: string): string {
  return ts.replaceAll(":", "-").replaceAll(".", "-");
}

function isFsErrorCode(error: unknown, code: string): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string" &&
    (error as { code: string }).code === code
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function resolveClobberPaths(configPath: string): {
  dir: string;
  prefix: string;
  lockPath: string;
} {
  const dir = path.dirname(configPath);
  const basename = path.basename(configPath);
  return {
    dir,
    prefix: `${basename}.clobbered.`,
    lockPath: path.join(dir, `${basename}.clobber.lock`),
  };
}

function shouldRemoveStaleLock(mtimeMs: number | undefined, nowMs: number): boolean {
  return typeof mtimeMs === "number" && nowMs - mtimeMs > CONFIG_CLOBBER_LOCK_STALE_MS;
}

async function acquireClobberLock(
  deps: ConfigClobberSnapshotDeps,
  lockPath: string,
): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < CONFIG_CLOBBER_LOCK_TIMEOUT_MS) {
    try {
      await deps.fs.promises.mkdir(lockPath, { mode: 0o700 });
      return true;
    } catch (error) {
      if (!isFsErrorCode(error, "EEXIST")) {
        return false;
      }
      const stat = await deps.fs.promises.stat(lockPath).catch(() => null);
      if (shouldRemoveStaleLock(stat?.mtimeMs, Date.now())) {
        await deps.fs.promises.rmdir(lockPath).catch(() => {});
        continue;
      }
      await sleep(CONFIG_CLOBBER_LOCK_RETRY_MS);
    }
  }
  return false;
}

function acquireClobberLockSync(deps: ConfigClobberSnapshotDeps, lockPath: string): boolean {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      deps.fs.mkdirSync(lockPath, { mode: 0o700 });
      return true;
    } catch (error) {
      if (!isFsErrorCode(error, "EEXIST")) {
        return false;
      }
      const stat = deps.fs.statSync(lockPath, { throwIfNoEntry: false });
      if (!shouldRemoveStaleLock(stat?.mtimeMs, Date.now())) {
        return false;
      }
      try {
        deps.fs.rmdirSync(lockPath);
      } catch {
        return false;
      }
    }
  }
  return false;
}

type ClobberedSiblingSnapshot = {
  name: string;
  path: string;
  timestampKey: string;
  mtimeMs: number;
};

function compareClobberedSiblings(
  left: ClobberedSiblingSnapshot,
  right: ClobberedSiblingSnapshot,
): number {
  return (
    left.timestampKey.localeCompare(right.timestampKey) ||
    left.mtimeMs - right.mtimeMs ||
    left.name.localeCompare(right.name)
  );
}

function createClobberedSiblingSnapshot(params: {
  dir: string;
  entry: string;
  prefix: string;
  mtimeMs: number;
}): ClobberedSiblingSnapshot {
  return {
    name: params.entry,
    path: path.join(params.dir, params.entry),
    timestampKey: params.entry.slice(params.prefix.length).replace(/-\d{2}$/, ""),
    mtimeMs: params.mtimeMs,
  };
}

async function listClobberedSiblings(
  deps: ConfigClobberSnapshotDeps,
  dir: string,
  prefix: string,
): Promise<ClobberedSiblingSnapshot[]> {
  try {
    const entries = await deps.fs.promises.readdir(dir);
    const snapshots: ClobberedSiblingSnapshot[] = [];
    for (const entry of entries) {
      if (!entry.startsWith(prefix)) {
        continue;
      }
      const stat = await deps.fs.promises.stat(path.join(dir, entry)).catch(() => null);
      snapshots.push(
        createClobberedSiblingSnapshot({
          dir,
          entry,
          prefix,
          mtimeMs: stat?.mtimeMs ?? 0,
        }),
      );
    }
    return snapshots.toSorted(compareClobberedSiblings);
  } catch {
    return [];
  }
}

function listClobberedSiblingsSync(
  deps: ConfigClobberSnapshotDeps,
  dir: string,
  prefix: string,
): ClobberedSiblingSnapshot[] {
  try {
    const snapshots: ClobberedSiblingSnapshot[] = [];
    for (const entry of deps.fs.readdirSync(dir)) {
      if (!entry.startsWith(prefix)) {
        continue;
      }
      const stat = deps.fs.statSync(path.join(dir, entry), { throwIfNoEntry: false });
      snapshots.push(
        createClobberedSiblingSnapshot({
          dir,
          entry,
          prefix,
          mtimeMs: stat?.mtimeMs ?? 0,
        }),
      );
    }
    return snapshots.toSorted(compareClobberedSiblings);
  } catch {
    return [];
  }
}

function warnClobberCapReached(
  deps: ConfigClobberSnapshotDeps,
  configPath: string,
  existing: number,
): void {
  if (clobberCapWarnedPaths.has(configPath)) {
    return;
  }
  clobberCapWarnedPaths.add(configPath);
  deps.logger.warn(
    `Config clobber snapshot cap reached for ${configPath}: ${existing} existing .clobbered.* files; rotating oldest snapshots to preserve the latest forensic copy.`,
  );
}

async function rotateOldestClobberedSiblings(
  deps: ConfigClobberSnapshotDeps,
  snapshots: ClobberedSiblingSnapshot[],
): Promise<boolean> {
  const deleteCount = Math.max(0, snapshots.length - CONFIG_CLOBBER_SNAPSHOT_LIMIT + 1);
  for (const snapshot of snapshots.slice(0, deleteCount)) {
    try {
      await deps.fs.promises.unlink(snapshot.path);
    } catch (error) {
      if (!isFsErrorCode(error, "ENOENT")) {
        return false;
      }
    }
  }
  return true;
}

function rotateOldestClobberedSiblingsSync(
  deps: ConfigClobberSnapshotDeps,
  snapshots: ClobberedSiblingSnapshot[],
): boolean {
  const deleteCount = Math.max(0, snapshots.length - CONFIG_CLOBBER_SNAPSHOT_LIMIT + 1);
  for (const snapshot of snapshots.slice(0, deleteCount)) {
    try {
      deps.fs.unlinkSync(snapshot.path);
    } catch (error) {
      if (!isFsErrorCode(error, "ENOENT")) {
        return false;
      }
    }
  }
  return true;
}

function buildClobberedTargetPath(configPath: string, observedAt: string, attempt: number): string {
  const basePath = `${configPath}.clobbered.${formatConfigArtifactTimestamp(observedAt)}`;
  return attempt === 0 ? basePath : `${basePath}-${String(attempt).padStart(2, "0")}`;
}

export async function persistBoundedClobberedConfigSnapshot(params: {
  deps: ConfigClobberSnapshotDeps;
  configPath: string;
  raw: string;
  observedAt: string;
}): Promise<string | null> {
  const paths = resolveClobberPaths(params.configPath);
  const locked = await acquireClobberLock(params.deps, paths.lockPath);
  if (!locked) {
    return null;
  }
  try {
    const existing = await listClobberedSiblings(params.deps, paths.dir, paths.prefix);
    if (existing.length >= CONFIG_CLOBBER_SNAPSHOT_LIMIT) {
      warnClobberCapReached(params.deps, params.configPath, existing.length);
      const rotated = await rotateOldestClobberedSiblings(params.deps, existing);
      if (!rotated) {
        return null;
      }
    }
    for (let attempt = 0; attempt < CONFIG_CLOBBER_SNAPSHOT_LIMIT; attempt++) {
      const targetPath = buildClobberedTargetPath(params.configPath, params.observedAt, attempt);
      try {
        await params.deps.fs.promises.writeFile(targetPath, params.raw, {
          encoding: "utf-8",
          mode: 0o600,
          flag: "wx",
        });
        return targetPath;
      } catch (error) {
        if (!isFsErrorCode(error, "EEXIST")) {
          return null;
        }
      }
    }
    return null;
  } finally {
    await params.deps.fs.promises.rmdir(paths.lockPath).catch(() => {});
  }
}

export function persistBoundedClobberedConfigSnapshotSync(params: {
  deps: ConfigClobberSnapshotDeps;
  configPath: string;
  raw: string;
  observedAt: string;
}): string | null {
  const paths = resolveClobberPaths(params.configPath);
  if (!acquireClobberLockSync(params.deps, paths.lockPath)) {
    return null;
  }
  try {
    const existing = listClobberedSiblingsSync(params.deps, paths.dir, paths.prefix);
    if (existing.length >= CONFIG_CLOBBER_SNAPSHOT_LIMIT) {
      warnClobberCapReached(params.deps, params.configPath, existing.length);
      if (!rotateOldestClobberedSiblingsSync(params.deps, existing)) {
        return null;
      }
    }
    for (let attempt = 0; attempt < CONFIG_CLOBBER_SNAPSHOT_LIMIT; attempt++) {
      const targetPath = buildClobberedTargetPath(params.configPath, params.observedAt, attempt);
      try {
        params.deps.fs.writeFileSync(targetPath, params.raw, {
          encoding: "utf-8",
          mode: 0o600,
          flag: "wx",
        });
        return targetPath;
      } catch (error) {
        if (!isFsErrorCode(error, "EEXIST")) {
          return null;
        }
      }
    }
    return null;
  } finally {
    try {
      params.deps.fs.rmdirSync(paths.lockPath);
    } catch {}
  }
}
