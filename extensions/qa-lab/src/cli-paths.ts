import fs from "node:fs/promises";
import path from "node:path";

export function resolveRepoRelativeOutputDir(repoRoot: string, outputDir?: string) {
  if (!outputDir) {
    return undefined;
  }
  if (path.isAbsolute(outputDir)) {
    throw new Error("--output-dir must be a relative path inside the repo root.");
  }
  const resolved = path.resolve(repoRoot, outputDir);
  const relative = path.relative(repoRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("--output-dir must stay within the repo root.");
  }
  return resolved;
}

async function resolveNearestExistingPath(targetPath: string) {
  let current = path.resolve(targetPath);
  while (true) {
    try {
      await fs.lstat(current);
      return current;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
    const parent = path.dirname(current);
    if (parent === current) {
      throw new Error(`failed to resolve existing path for ${targetPath}`);
    }
    current = parent;
  }
}

function assertRepoRelativePath(repoRoot: string, targetPath: string, label: string) {
  const relative = path.relative(repoRoot, targetPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} must stay within the repo root.`);
  }
  return relative;
}

async function assertNoSymlinkSegments(repoRoot: string, targetPath: string, label: string) {
  const relative = assertRepoRelativePath(repoRoot, targetPath, label);
  let current = repoRoot;
  for (const segment of relative.split(path.sep).filter((entry) => entry.length > 0)) {
    current = path.join(current, segment);
    let stats: Awaited<ReturnType<typeof fs.lstat>> | null = null;
    try {
      stats = await fs.lstat(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        break;
      }
      throw error;
    }
    if (stats.isSymbolicLink()) {
      throw new Error(`${label} must not traverse symlinks.`);
    }
  }
}

export async function assertRepoBoundPath(repoRoot: string, targetPath: string, label: string) {
  const repoRootResolved = path.resolve(repoRoot);
  const targetResolved = path.resolve(targetPath);
  assertRepoRelativePath(repoRootResolved, targetResolved, label);
  await assertNoSymlinkSegments(repoRootResolved, targetResolved, label);
  const repoRootReal = await fs.realpath(repoRootResolved);
  const nearestExistingPath = await resolveNearestExistingPath(targetResolved);
  const nearestExistingReal = await fs.realpath(nearestExistingPath);
  assertRepoRelativePath(repoRootReal, nearestExistingReal, label);
  return targetResolved;
}

export async function ensureRepoBoundDirectory(
  repoRoot: string,
  targetDir: string,
  label: string,
  opts?: { mode?: number },
) {
  const repoRootResolved = path.resolve(repoRoot);
  const targetResolved = path.resolve(targetDir);
  const relative = assertRepoRelativePath(repoRootResolved, targetResolved, label);
  const repoRootReal = await fs.realpath(repoRootResolved);
  let current = repoRootResolved;
  for (const segment of relative.split(path.sep).filter((entry) => entry.length > 0)) {
    current = path.join(current, segment);
    while (true) {
      try {
        const stats = await fs.lstat(current);
        if (stats.isSymbolicLink()) {
          throw new Error(`${label} must not traverse symlinks.`);
        }
        if (!stats.isDirectory()) {
          throw new Error(`${label} must point to a directory.`);
        }
        break;
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT") {
          throw error;
        }
        try {
          await fs.mkdir(current, { recursive: false, mode: opts?.mode });
        } catch (mkdirError) {
          if ((mkdirError as NodeJS.ErrnoException).code === "EEXIST") {
            continue;
          }
          throw mkdirError;
        }
      }
    }
  }
  const targetReal = await fs.realpath(targetResolved);
  assertRepoRelativePath(repoRootReal, targetReal, label);
  return targetResolved;
}
