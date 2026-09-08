import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { requireDirectorySync, sha256File, syncDirectory } from "./directory-durability.js";
import { hasNodeErrorCode } from "./path-guards.js";

export type CheckpointFileState = {
  kind: "file" | "directory";
  sha256: string;
  mode: number;
  /** Physical identities of descendant directory entries; separate from portable content. */
  descendantIdentitySha256?: string;
  identity: { dev: number; ino: number; size: number; mtimeMs: number; ctimeMs: number };
};

/** Directory digests bind names, link text, file bytes, and modes, never link targets. */
export async function inspectCheckpointFile(file: string): Promise<CheckpointFileState | null> {
  let stat;
  try {
    stat = await fs.lstat(file);
  } catch (error) {
    if (hasNodeErrorCode(error, "ENOENT")) {
      return null;
    }
    throw error;
  }
  if (!stat.isFile() && !stat.isDirectory()) {
    throw new Error(`Checkpoint resource must be a regular file or directory: ${file}`);
  }
  const hash = createHash("sha256");
  const identities = createHash("sha256");
  const visit = async (entryPath: string, relative: string): Promise<void> => {
    const entry = await fs.lstat(entryPath);
    // Root rename changes ctime during publication. Descendant identities do
    // not change, and must remain bound independently of portable tree bytes.
    if (relative) {
      identities.update(
        JSON.stringify([relative, entry.dev, entry.ino, entry.size, entry.mtimeMs, entry.ctimeMs]),
      );
    }
    if (entry.isSymbolicLink()) {
      hash.update(JSON.stringify([relative, "link", await fs.readlink(entryPath)]));
    } else if (entry.isDirectory()) {
      hash.update(JSON.stringify([relative, "directory", entry.mode & 0o777]));
      for (const name of (await fs.readdir(entryPath)).toSorted()) {
        await visit(path.join(entryPath, name), path.posix.join(relative, name));
      }
    } else if (entry.isFile()) {
      hash.update(
        JSON.stringify([relative, "file", entry.mode & 0o777, await sha256File(entryPath)]),
      );
    } else {
      throw new Error(`Checkpoint resource contains a special file: ${entryPath}`);
    }
    const after = await fs.lstat(entryPath);
    if (
      entry.dev !== after.dev ||
      entry.ino !== after.ino ||
      entry.size !== after.size ||
      entry.mtimeMs !== after.mtimeMs ||
      entry.ctimeMs !== after.ctimeMs
    ) {
      throw new Error(`Checkpoint resource changed during inspection: ${entryPath}`);
    }
  };
  await visit(file, "");
  return {
    kind: stat.isDirectory() ? "directory" : "file",
    sha256: hash.digest("hex"),
    descendantIdentitySha256: identities.digest("hex"),
    mode: stat.mode & 0o777,
    identity: {
      dev: stat.dev,
      ino: stat.ino,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ctimeMs: stat.ctimeMs,
    },
  };
}

export function checkpointContentMatches(
  left: CheckpointFileState | null,
  right: CheckpointFileState | null,
): boolean {
  return left === null || right === null
    ? left === right
    : left.kind === right.kind && left.sha256 === right.sha256 && left.mode === right.mode;
}

export async function syncCheckpointTree(file: string): Promise<void> {
  const stat = await fs.lstat(file);
  if (stat.isSymbolicLink()) {
    return;
  }
  if (stat.isDirectory()) {
    for (const name of await fs.readdir(file)) {
      await syncCheckpointTree(path.join(file, name));
    }
    requireDirectorySync(await syncDirectory(file), "Checkpoint directory");
  } else {
    const handle = await fs.open(file, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}

/** Copy into an absent artifact path; a failed copy is never published as a checkpoint. */
export async function copyCheckpointFile(
  source: string,
  target: string,
  expected: CheckpointFileState,
): Promise<CheckpointFileState> {
  if (await inspectCheckpointFile(target)) {
    throw new Error(`Checkpoint target already exists: ${target}`);
  }
  await fs.cp(source, target, {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
    errorOnExist: true,
    force: false,
  });
  const copied = await inspectCheckpointFile(target);
  const current = await inspectCheckpointFile(source);
  if (
    !copied ||
    !checkpointContentMatches(copied, expected) ||
    !checkpointContentMatches(current, expected)
  ) {
    throw new Error(`Checkpoint copy changed: ${source}`);
  }
  await syncCheckpointTree(target);
  return copied;
}
