// Maps state symbolic links onto the portable archive targets a restore can follow.
import { readlinkSync, realpathSync } from "node:fs";
import path from "node:path";
import { buildBackupArchivePath, type BackupAsset } from "../commands/backup-shared.js";
import { isPathWithin } from "../commands/cleanup-utils.js";

function isRemappableAbsoluteSymbolicLinkTarget(linkpath: string | undefined): linkpath is string {
  // A backslash target cannot become a portable archive path at all, so it stays
  // with the archive guard instead of taking the declared-asset remap.
  return linkpath !== undefined && path.isAbsolute(linkpath) && !linkpath.includes("\\");
}

// Tar exposes the first link hop, while assets own the final canonical path.
// Resolve before containment so chains map to one portable archive target.
function resolveDeclaredSymbolicLinkTargetSourcePath(
  linkpath: string,
  assets: readonly BackupAsset[],
): string | undefined {
  let targetSourcePath: string;
  try {
    targetSourcePath = realpathSync(linkpath);
  } catch {
    return undefined;
  }
  return assets.some((asset) => isPathWithin(targetSourcePath, asset.sourcePath))
    ? targetSourcePath
    : undefined;
}

/** Rewrite an absolute link target owned by a declared asset into an archive-relative one. */
export function remapDeclaredAbsoluteSymbolicLinkTarget(params: {
  linkpath: string | undefined;
  archiveEntryPath: string;
  archiveRoot: string;
  assets: readonly BackupAsset[];
}): string | undefined {
  if (!isRemappableAbsoluteSymbolicLinkTarget(params.linkpath)) {
    return params.linkpath;
  }
  const targetSourcePath = resolveDeclaredSymbolicLinkTargetSourcePath(
    params.linkpath,
    params.assets,
  );
  if (!targetSourcePath) {
    return params.linkpath;
  }
  return path.posix.relative(
    path.posix.dirname(params.archiveEntryPath),
    buildBackupArchivePath(params.archiveRoot, targetSourcePath),
  );
}

/**
 * An absolute target no asset owns has no portable archive path, so the link
 * cannot be restored and creation reports it instead of failing the whole backup.
 * Every link that is archived still passes `assertArchiveSymbolicLinkTarget`.
 */
export function isUnrestorableSymbolicLinkTarget(
  linkpath: string,
  assets: readonly BackupAsset[],
): boolean {
  return (
    isRemappableAbsoluteSymbolicLinkTarget(linkpath) &&
    !resolveDeclaredSymbolicLinkTargetSourcePath(linkpath, assets)
  );
}

/** Read a link target during traversal; a link that vanished has no target to judge. */
export function readSymbolicLinkTarget(sourcePath: string): string | undefined {
  try {
    return readlinkSync(sourcePath);
  } catch {
    return undefined;
  }
}
