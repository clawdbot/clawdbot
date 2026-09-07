import fs from "node:fs/promises";
import path from "node:path";
import { hasErrnoCode } from "./errors.js";
import { movePathWithCopyFallback } from "./replace-file.js";

export const PACKAGE_MANAGER_SWAP_SOURCE_HARDLINKS = "allow" as const;

export async function packagePathEntryExists(targetPath: string): Promise<boolean> {
  try {
    await fs.lstat(targetPath);
    return true;
  } catch (error) {
    if (hasErrnoCode(error, "ENOENT")) {
      return false;
    }
    throw error;
  }
}

export async function packagePathEntriesMatch(left: string, right: string): Promise<boolean> {
  const [leftStat, rightStat] = await Promise.all([
    fs.lstat(left).catch(() => null),
    fs.lstat(right).catch(() => null),
  ]);
  if (!leftStat || !rightStat) {
    return false;
  }
  if (leftStat.isSymbolicLink() || rightStat.isSymbolicLink()) {
    return (
      leftStat.isSymbolicLink() &&
      rightStat.isSymbolicLink() &&
      (await fs.readlink(left)) === (await fs.readlink(right))
    );
  }
  if (!leftStat.isFile() || !rightStat.isFile()) {
    return false;
  }
  if ((leftStat.mode & 0o777) !== (rightStat.mode & 0o777) || leftStat.size !== rightStat.size) {
    return false;
  }
  const [leftContents, rightContents] = await Promise.all([fs.readFile(left), fs.readFile(right)]);
  return leftContents.equals(rightContents);
}

export async function activateStagedNpmPackageRoot(
  source: string,
  destination: string,
  assertCurrent?: () => void,
): Promise<void> {
  if (assertCurrent) {
    // A durable descriptor binds the staged inode. A copied replacement would
    // invalidate that evidence and cannot be silently admitted for recovery.
    assertCurrent();
    await fs.rename(source, destination);
    return;
  }
  const stat = await fs.lstat(source);
  if (!stat.isSymbolicLink()) {
    await movePathWithCopyFallback({
      from: source,
      sourceHardlinks: PACKAGE_MANAGER_SWAP_SOURCE_HARDLINKS,
      to: destination,
    });
    return;
  }

  // npm represents global local-directory installs as relative symlinks. Moving
  // one changes its meaning, so activate the same canonical source explicitly.
  const canonicalSource = await fs.realpath(source);
  await fs.symlink(
    canonicalSource,
    destination,
    process.platform === "win32" ? "junction" : undefined,
  );
}

export function removePackagePath(target: string): Promise<void> {
  return fs.rm(target, {
    recursive: true,
    force: true,
    maxRetries: process.platform === "win32" ? 5 : 2,
    retryDelay: 100,
  });
}

export async function copyPackagePathEntry(
  source: string,
  destination: string,
  assertCurrent = () => {},
): Promise<void> {
  const stat = await fs.lstat(source);
  assertCurrent();
  if (stat.isDirectory()) {
    await removePackagePath(destination);
    assertCurrent();
    await fs.cp(source, destination, { recursive: true, force: true, preserveTimestamps: false });
    return;
  }
  // A partial launcher cannot be reconciled as either generation. Prepare its
  // replacement beside the destination so publication leaves exact old or new bytes.
  const staging = await fs.mkdtemp(path.join(path.dirname(destination), ".openclaw-shim-stage-"));
  const staged = path.join(staging, "entry");
  try {
    if (stat.isSymbolicLink()) {
      const target = await fs.readlink(source);
      assertCurrent();
      await fs.symlink(target, staged);
    } else {
      assertCurrent();
      await fs.copyFile(source, staged);
      assertCurrent();
      await fs.chmod(staged, stat.mode);
    }
    assertCurrent();
    await fs.rename(staged, destination);
  } finally {
    await removePackagePath(staging);
  }
}

/** The caller verifies recovery material before this exact-object publication. */
export async function restoreNpmPackageRoot(params: {
  liveRoot: string;
  backupRoot: string;
  displacedRoot: string;
  candidatePresent: boolean;
  assertCurrent?: () => void;
}): Promise<void> {
  const assertCurrent = params.assertCurrent ?? (() => {});
  if (params.candidatePresent) {
    assertCurrent();
    await fs.rename(params.liveRoot, params.displacedRoot);
  }
  try {
    assertCurrent();
    await fs.rename(params.backupRoot, params.liveRoot);
  } catch (error) {
    // A denied rename must leave the candidate available. Never substitute a
    // copied old tree for the exact object whose identity was verified.
    if (params.candidatePresent) {
      assertCurrent();
      await fs.rename(params.displacedRoot, params.liveRoot);
    }
    throw error;
  }
}

/** Retire only obsolete backups after restoration or verified activation. */
export async function discardPackageUpdateBackup(
  backupPath: string,
  label: string,
  globalRoot: string,
): Promise<string | null> {
  try {
    await removePackagePath(backupPath);
    return null;
  } catch {
    const retiredPath = path.join(
      globalRoot,
      path.basename(backupPath).replace(/^\.openclaw\./, ".openclaw-"),
    );
    try {
      // npm may clean the disposable namespace on a later update. Only an
      // already-obsolete backup can enter it; failure preserves the artifact.
      await fs.rename(backupPath, retiredPath);
      return `preserved ${label} at ${retiredPath} for delayed cleanup`;
    } catch {
      return `preserved ${label} at ${backupPath}; remove it manually after verifying the installation`;
    }
  }
}
