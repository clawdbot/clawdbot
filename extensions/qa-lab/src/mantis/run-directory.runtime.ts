// Qa Lab plugin module owns Mantis directory identity capture.
import fs from "node:fs/promises";
import path from "node:path";
import { assertNoSymlinkParents } from "openclaw/plugin-sdk/security-runtime";

export type MantisDirectoryOwnership = {
  parentDevice: bigint;
  parentInode: bigint;
  targetDevice: bigint;
  targetInode: bigint;
};

export function hasSameFileIdentity(
  first: { dev: bigint; ino: bigint },
  second: { dev: bigint; ino: bigint },
): boolean {
  return first.dev === second.dev && first.ino === second.ino;
}

export async function captureMantisDirectoryOwnership(params: {
  directoryPath: string;
  repoRoot: string;
}): Promise<MantisDirectoryOwnership> {
  const repoRoot = path.resolve(params.repoRoot);
  const directoryPath = path.resolve(params.directoryPath);

  await assertNoSymlinkParents({ rootDir: repoRoot, targetPath: directoryPath });
  const [parentStat, targetStat] = await Promise.all([
    fs.lstat(path.dirname(directoryPath), { bigint: true }),
    fs.lstat(directoryPath, { bigint: true }),
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
