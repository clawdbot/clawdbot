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

async function countClobberedSiblings(
  deps: ConfigClobberSnapshotDeps,
  dir: string,
  prefix: string,
): Promise<number> {
  try {
    const entries = await deps.fs.promises.readdir(dir);
    return entries.filter((entry) => entry.startsWith(prefix)).length;
  } catch {
    return 0;
  }
}

function countClobberedSiblingsSync(
  deps: ConfigClobberSnapshotDeps,
  dir: string,
  prefix: string,
): number {
  try {
    return deps.fs.readdirSync(dir).filter((entry) => entry.startsWith(prefix)).length;
  } catch {
    return 0;
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
    `Config clobber snapshot cap reached for ${configPath}: ${existing} existing .clobbered.* files; skipping additional forensic snapshots.`,
  );
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
    const existing = await countClobberedSiblings(params.deps, paths.dir, paths.prefix);
    if (existing >= CONFIG_CLOBBER_SNAPSHOT_LIMIT) {
      warnClobberCapReached(params.deps, params.configPath, existing);
      return null;
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
    const existing = countClobberedSiblingsSync(params.deps, paths.dir, paths.prefix);
    if (existing >= CONFIG_CLOBBER_SNAPSHOT_LIMIT) {
      warnClobberCapReached(params.deps, params.configPath, existing);
      return null;
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
