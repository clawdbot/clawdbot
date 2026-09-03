/** Whole-tree manifests and immutable copy support for update generations. */
import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { hasErrnoCode } from "./errors.js";
import type { UpdateGenerationManifest } from "./update-generation-contract.js";

type GenerationManifestEntry =
  | { path: string; type: "directory"; mode: number }
  | { path: string; type: "file"; mode: number; size: number; sha256: string }
  | { path: string; type: "symlink"; target: string };

export function updateGenerationPathIsEqualOrNested(
  parentPath: string,
  candidatePath: string,
): boolean {
  const relative = path.relative(parentPath, candidatePath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function hashFile(filePath: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
  }
  return hash.digest("hex");
}

function normalizedMode(mode: number): number {
  return mode & 0o555;
}

export async function captureUpdateGenerationManifest(
  root: string,
): Promise<UpdateGenerationManifest> {
  const rootPath = path.resolve(root);
  const rootStat = await fs.lstat(rootPath);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`Update generation source is not a directory: ${rootPath}`);
  }
  const entries: GenerationManifestEntry[] = [];
  let totalBytes = 0;

  const walk = async (current: string, relativeDirectory: string): Promise<void> => {
    const children = (await fs.readdir(current)).toSorted((left, right) =>
      left.localeCompare(right),
    );
    for (const child of children) {
      const childPath = path.join(current, child);
      const relativePath = relativeDirectory ? `${relativeDirectory}/${child}` : child;
      const stat = await fs.lstat(childPath);
      if (stat.isSymbolicLink()) {
        const target = await fs.readlink(childPath);
        if (path.isAbsolute(target) || path.win32.isAbsolute(target)) {
          throw new Error(`Update generation contains an absolute symlink: ${relativePath}`);
        }
        const resolvedTarget = path.resolve(path.dirname(childPath), target);
        if (!updateGenerationPathIsEqualOrNested(rootPath, resolvedTarget)) {
          throw new Error(`Update generation symlink escapes its source: ${relativePath}`);
        }
        entries.push({ path: relativePath, type: "symlink", target });
        continue;
      }
      if (stat.isDirectory()) {
        entries.push({ path: relativePath, type: "directory", mode: normalizedMode(stat.mode) });
        await walk(childPath, relativePath);
        continue;
      }
      if (!stat.isFile()) {
        throw new Error(`Update generation contains an unsupported entry: ${relativePath}`);
      }
      const sha256 = await hashFile(childPath);
      totalBytes += stat.size;
      entries.push({
        path: relativePath,
        type: "file",
        mode: normalizedMode(stat.mode),
        size: stat.size,
        sha256,
      });
    }
  };
  await walk(rootPath, "");
  const digest = createHash("sha256")
    .update(entries.map((entry) => JSON.stringify(entry)).join("\n"))
    .digest("hex");
  return {
    algorithm: "sha256",
    digest,
    entryCount: entries.length,
    totalBytes,
  };
}

export async function sealUpdateGenerationTree(root: string): Promise<void> {
  const directories: Array<{ path: string; mode: number }> = [];
  const walk = async (current: string): Promise<void> => {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      const stat = await fs.lstat(entryPath);
      if (stat.isSymbolicLink()) {
        continue;
      }
      if (stat.isDirectory()) {
        directories.push({ path: entryPath, mode: normalizedMode(stat.mode) });
        await walk(entryPath);
      } else if (stat.isFile()) {
        await fs.chmod(entryPath, normalizedMode(stat.mode));
      }
    }
  };
  const rootStat = await fs.lstat(root);
  directories.push({ path: root, mode: normalizedMode(rootStat.mode) });
  await walk(root);
  for (const directory of directories.toReversed()) {
    await fs.chmod(directory.path, directory.mode);
  }
}

export async function syncUpdateGenerationPath(filePath: string): Promise<void> {
  try {
    const handle = await fs.open(filePath, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (
      !hasErrnoCode(error, "EISDIR") &&
      !hasErrnoCode(error, "EINVAL") &&
      !hasErrnoCode(error, "EPERM") &&
      !hasErrnoCode(error, "EACCES")
    ) {
      throw error;
    }
  }
}

export async function syncUpdateGenerationTree(root: string): Promise<void> {
  const walk = async (current: string): Promise<void> => {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        await walk(entryPath);
      } else if (entry.isFile()) {
        await syncUpdateGenerationPath(entryPath);
      }
    }
    await syncUpdateGenerationPath(current);
  };
  await walk(root);
}

async function makeUpdateGenerationTreeWritable(root: string): Promise<void> {
  const stat = await fs.lstat(root).catch(() => null);
  if (!stat || stat.isSymbolicLink()) {
    return;
  }
  if (stat.isDirectory()) {
    await fs.chmod(root, stat.mode | 0o700).catch(() => undefined);
    for (const entry of await fs.readdir(root)) {
      await makeUpdateGenerationTreeWritable(path.join(root, entry));
    }
  } else {
    await fs.chmod(root, stat.mode | 0o600).catch(() => undefined);
  }
}

export async function removeUpdateGenerationTree(root: string): Promise<void> {
  await makeUpdateGenerationTreeWritable(root);
  await fs.rm(root, { recursive: true, force: true });
}
