import fs from "node:fs/promises";
import path from "node:path";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/text-runtime";

export const DEFAULT_OPEN_SHELL_MIRROR_EXCLUDE_DIRS = ["hooks", "git-hooks", ".git"] as const;
const COPY_TREE_FS_CONCURRENCY = 16;

function createExcludeMatcher(excludeDirs?: readonly string[]) {
  const excluded = new Set((excludeDirs ?? []).map((d) => normalizeLowercaseStringOrEmpty(d)));
  return (name: string) => excluded.has(normalizeLowercaseStringOrEmpty(name));
}

function createConcurrencyLimiter(limit: number) {
  let active = 0;
  const queue: Array<() => void> = [];

  const release = () => {
    active -= 1;
    queue.shift()?.();
  };

  return async <T>(task: () => Promise<T>): Promise<T> => {
    if (active >= limit) {
      await new Promise<void>((resolve) => {
        queue.push(resolve);
      });
    }
    active += 1;
    try {
      return await task();
    } finally {
      release();
    }
  };
}

const runLimitedFs = createConcurrencyLimiter(COPY_TREE_FS_CONCURRENCY);

async function lstatIfExists(targetPath: string) {
  return await runLimitedFs(async () => await fs.lstat(targetPath)).catch(() => null);
}

async function copyTreeWithoutSymlinks(params: {
  sourcePath: string;
  targetPath: string;
  preserveTargetSymlinks?: boolean;
}): Promise<void> {
  const stats = await runLimitedFs(async () => await fs.lstat(params.sourcePath));
  // Mirror sync only carries regular files and directories across the
  // host/sandbox boundary. Symlinks and special files are dropped.
  if (stats.isSymbolicLink()) {
    return;
  }
  const targetStats = await lstatIfExists(params.targetPath);
  if (params.preserveTargetSymlinks && targetStats?.isSymbolicLink()) {
    return;
  }
  if (stats.isDirectory()) {
    await runLimitedFs(async () => await fs.mkdir(params.targetPath, { recursive: true }));
    const entries = await runLimitedFs(async () => await fs.readdir(params.sourcePath));
    await Promise.all(
      entries.map(async (entry) => {
        await copyTreeWithoutSymlinks({
          sourcePath: path.join(params.sourcePath, entry),
          targetPath: path.join(params.targetPath, entry),
          preserveTargetSymlinks: params.preserveTargetSymlinks,
        });
      }),
    );
    return;
  }
  if (stats.isFile()) {
    await runLimitedFs(
      async () => await fs.mkdir(path.dirname(params.targetPath), { recursive: true }),
    );
    await runLimitedFs(async () => await fs.copyFile(params.sourcePath, params.targetPath));
  }
}

export async function replaceDirectoryContents(params: {
  sourceDir: string;
  targetDir: string;
  /** Top-level directory names to exclude from sync (preserved in target, skipped from source). */
  excludeDirs?: readonly string[];
}): Promise<void> {
  const isExcluded = createExcludeMatcher(params.excludeDirs);
  await fs.mkdir(params.targetDir, { recursive: true });
  const existing = await fs.readdir(params.targetDir);
  await Promise.all(
    existing
      .filter((entry) => !isExcluded(entry))
      .map(async (entry) => {
        const targetPath = path.join(params.targetDir, entry);
        const stats = await lstatIfExists(targetPath);
        if (stats?.isSymbolicLink()) {
          return;
        }
        await runLimitedFs(
          async () =>
            await fs.rm(targetPath, {
              recursive: true,
              force: true,
            }),
        );
      }),
  );
  const sourceEntries = await fs.readdir(params.sourceDir);
  for (const entry of sourceEntries) {
    if (isExcluded(entry)) {
      continue;
    }
    await copyTreeWithoutSymlinks({
      sourcePath: path.join(params.sourceDir, entry),
      targetPath: path.join(params.targetDir, entry),
      preserveTargetSymlinks: true,
    });
  }
}

export async function stageDirectoryContents(params: {
  sourceDir: string;
  targetDir: string;
  /** Top-level directory names to exclude from the staged upload. */
  excludeDirs?: readonly string[];
}): Promise<void> {
  const isExcluded = createExcludeMatcher(params.excludeDirs);
  await fs.mkdir(params.targetDir, { recursive: true });
  const sourceEntries = await fs.readdir(params.sourceDir);
  for (const entry of sourceEntries) {
    if (isExcluded(entry)) {
      continue;
    }
    await copyTreeWithoutSymlinks({
      sourcePath: path.join(params.sourceDir, entry),
      targetPath: path.join(params.targetDir, entry),
    });
  }
}

export async function movePathWithCopyFallback(params: {
  from: string;
  to: string;
}): Promise<void> {
  try {
    await fs.rename(params.from, params.to);
    return;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code !== "EXDEV") {
      throw error;
    }
  }
  await fs.cp(params.from, params.to, {
    recursive: true,
    force: true,
    dereference: false,
  });
  await fs.rm(params.from, { recursive: true, force: true });
}
