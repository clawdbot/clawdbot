// Qa Lab plugin module owns Mantis directory identity capture.
import fs from "node:fs/promises";
import path from "node:path";
import { assertNoSymlinkParents } from "openclaw/plugin-sdk/security-runtime";

export type MantisDirectoryOwnership = {
  parentDevice: number;
  parentInode: number;
  targetDevice: number;
  targetInode: number;
};

export function hasSameFileIdentity(
  first: { dev: number; ino: number },
  second: { dev: number; ino: number },
): boolean {
  return first.dev === second.dev && first.ino === second.ino;
}

export function isMantisDirectoryNotEmptyError(error: unknown): boolean {
  const seen = new Set<object>();
  let current = error;
  while (typeof current === "object" && current !== null && !seen.has(current)) {
    seen.add(current);
    if ("code" in current && current.code === "not-empty") {
      return true;
    }
    current = "cause" in current ? current.cause : undefined;
  }
  return false;
}

export async function captureMantisDirectoryOwnership(params: {
  directoryPath: string;
  repoRoot: string;
}): Promise<MantisDirectoryOwnership> {
  const repoRoot = path.resolve(params.repoRoot);
  const directoryPath = path.resolve(params.directoryPath);

  await assertNoSymlinkParents({ rootDir: repoRoot, targetPath: directoryPath });
  const [parentStat, targetStat] = await Promise.all([
    fs.lstat(path.dirname(directoryPath)),
    fs.lstat(directoryPath),
  ]);
  if (targetStat.isSymbolicLink() || !targetStat.isDirectory()) {
    throw new Error(`Mantis owned path is not a real directory: ${directoryPath}`);
  }
  return {
    parentDevice: parentStat.dev,
    parentInode: parentStat.ino,
    targetDevice: targetStat.dev,
    targetInode: targetStat.ino,
  };
}

export async function assertMantisDirectoryOwnership(params: {
  directoryPath: string;
  ownership: MantisDirectoryOwnership;
  repoRoot: string;
}): Promise<void> {
  const current = await captureMantisDirectoryOwnership({
    directoryPath: params.directoryPath,
    repoRoot: params.repoRoot,
  });
  if (
    current.parentDevice !== params.ownership.parentDevice ||
    current.parentInode !== params.ownership.parentInode ||
    current.targetDevice !== params.ownership.targetDevice ||
    current.targetInode !== params.ownership.targetInode
  ) {
    throw new Error(`Mantis owned path was replaced: ${path.resolve(params.directoryPath)}`);
  }
}

export async function createMantisOwnedDirectory(params: {
  directoryPath: string;
  repoRoot: string;
}): Promise<MantisDirectoryOwnership> {
  const repoRoot = path.resolve(params.repoRoot);
  const directoryPath = path.resolve(params.directoryPath);
  const parentDir = path.dirname(directoryPath);

  await assertNoSymlinkParents({ rootDir: repoRoot, targetPath: directoryPath });
  const parentStat = await fs.lstat(parentDir);
  await fs.mkdir(directoryPath);
  const targetStat = await fs.lstat(directoryPath);
  return {
    parentDevice: parentStat.dev,
    parentInode: parentStat.ino,
    targetDevice: targetStat.dev,
    targetInode: targetStat.ino,
  };
}
