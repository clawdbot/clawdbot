import fs from "node:fs/promises";
import path from "node:path";
import { assertNoSymlinkParents, pathScope } from "openclaw/plugin-sdk/security-runtime";

export function resolveRepoRelativeOutputDir(repoRoot: string, outputDir?: string) {
  if (!outputDir) {
    return undefined;
  }
  if (path.isAbsolute(outputDir)) {
    throw new Error("--output-dir must be a relative path inside the repo root.");
  }
  const resolved = pathScope(repoRoot, { label: "repo root" }).resolve(outputDir);
  if (!resolved.ok) {
    throw new Error("--output-dir must stay within the repo root.");
  }
  return resolved.path;
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
  assertRepoRelativePath(repoRoot, targetPath, label);
  try {
    await assertNoSymlinkParents({
      rootDir: repoRoot,
      targetPath,
      messagePrefix: label,
    });
  } catch (error) {
    if (error instanceof Error && error.message.includes("symlink")) {
      throw new Error(`${label} must not traverse symlinks.`, { cause: error });
    }
    throw error;
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
  await assertNoSymlinkSegments(path.resolve(repoRoot), path.resolve(targetDir), label);
  const result = await pathScope(repoRoot, { label }).ensureDir(targetDir, { mode: opts?.mode });
  if (!result.ok) {
    throw new Error(`${label} must stay within the repo root.`);
  }
  return result.path;
}
