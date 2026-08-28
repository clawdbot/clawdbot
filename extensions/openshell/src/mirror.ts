// Openshell plugin module implements mirror behavior.
import fs from "node:fs/promises";
import path from "node:path";
import { extractErrorCode, movePathWithCopyFallback } from "openclaw/plugin-sdk/security-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import pLimit from "p-limit";

export const DEFAULT_OPEN_SHELL_MIRROR_EXCLUDE_DIRS = ["hooks", "git-hooks", ".git"] as const;
const COPY_TREE_FS_CONCURRENCY = 16;

function createExcludeMatcher(excludeDirs?: readonly string[]) {
  const excluded = new Set((excludeDirs ?? []).map((d) => normalizeLowercaseStringOrEmpty(d)));
  return (name: string) => excluded.has(normalizeLowercaseStringOrEmpty(name));
}

const runLimitedFs = pLimit(COPY_TREE_FS_CONCURRENCY);

async function lstatIfExists(targetPath: string) {
  return await runLimitedFs(fs.lstat, targetPath).catch((error: unknown) => {
    if (extractErrorCode(error) === "ENOENT") {
      return null;
    }
    throw error;
  });
}

async function reconcileMirrorPath(params: {
  sourcePath?: string;
  targetPath: string;
  replace: boolean;
}): Promise<boolean> {
  const targetStats = await lstatIfExists(params.targetPath);
  if (targetStats?.isSymbolicLink()) {
    return true;
  }
  const sourceStats = params.sourcePath ? await runLimitedFs(fs.lstat, params.sourcePath) : null;
  // Source symlinks and special files never cross the sandbox boundary.
  const sourceDir = sourceStats?.isDirectory() ? params.sourcePath : undefined;
  const sourceFile = sourceStats?.isFile() ? params.sourcePath : undefined;
  if (!params.replace && !sourceDir && !sourceFile) {
    return false;
  }
  if (sourceDir || targetStats?.isDirectory()) {
    if (targetStats && !targetStats.isDirectory()) {
      await runLimitedFs(fs.rm, params.targetPath, { force: true });
    }
    const preservedLinks = await reconcileMirrorDirectory({
      sourceDir,
      targetDir: params.targetPath,
      replace: params.replace,
    });
    // Host links also protect their ancestor directories. A conflicting remote
    // file cannot replace those directories, just as it cannot replace a link.
    if (sourceDir || preservedLinks) {
      return preservedLinks;
    }
    await runLimitedFs(fs.rmdir, params.targetPath);
  } else if (targetStats) {
    // Unlink before copying so a host hardlink cannot redirect the new content
    // into an inode outside the workspace.
    await runLimitedFs(fs.rm, params.targetPath, { force: true });
  }
  if (sourceFile) {
    await runLimitedFs(fs.copyFile, sourceFile, params.targetPath);
  }
  return false;
}

async function reconcileMirrorDirectory(params: {
  sourceDir?: string;
  targetDir: string;
  replace: boolean;
  excludeDirs?: readonly string[];
}): Promise<boolean> {
  const { sourceDir } = params;
  const isExcluded = createExcludeMatcher(params.excludeDirs);
  await runLimitedFs(fs.mkdir, params.targetDir, { recursive: true });
  const sourceEntries = new Set(
    sourceDir ? await runLimitedFs(async () => await fs.readdir(sourceDir)) : [],
  );
  const targetEntries = params.replace
    ? await runLimitedFs(async () => await fs.readdir(params.targetDir))
    : [];
  // Finish every mutation before returning an error and releasing the workspace lease.
  const results = await Promise.allSettled(
    [...new Set([...sourceEntries, ...targetEntries])]
      .filter((entry) => !isExcluded(entry))
      .map((entry) =>
        reconcileMirrorPath({
          sourcePath:
            sourceDir && sourceEntries.has(entry) ? path.join(sourceDir, entry) : undefined,
          targetPath: path.join(params.targetDir, entry),
          replace: params.replace,
        }),
      ),
  );
  let preservedLinks = false;
  for (const result of results) {
    if (result.status === "rejected") {
      throw result.reason;
    }
    preservedLinks ||= result.value;
  }
  return preservedLinks;
}

export async function replaceDirectoryContents(params: {
  sourceDir: string;
  targetDir: string;
  /** Top-level directory names to exclude from sync (preserved in target, skipped from source). */
  excludeDirs?: readonly string[];
}): Promise<void> {
  await reconcileMirrorDirectory({ ...params, replace: true });
}

export async function stageDirectoryContents(params: {
  sourceDir: string;
  targetDir: string;
  /** Top-level directory names to exclude from the staged upload. */
  excludeDirs?: readonly string[];
}): Promise<void> {
  await reconcileMirrorDirectory({ ...params, replace: false });
}

export { movePathWithCopyFallback };
