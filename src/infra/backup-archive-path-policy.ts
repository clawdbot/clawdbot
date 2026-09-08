// Owns which symbolic link targets an archive may carry, and how a state link
// becomes one. Creation and verification both read this policy, so the two
// commands cannot drift on what a restore is able to follow.
import { realpathSync } from "node:fs";
import path from "node:path";
import { buildBackupArchivePath, type BackupAsset } from "../commands/backup-shared.js";
import { isPathWithin } from "../commands/cleanup-utils.js";
import { isWindowsDrivePath } from "./archive-path.js";

// Creation and verification must agree on which archive paths can be restored.
function assertPortableRelativePathSyntax(
  value: string,
  label: string,
  reportedValue = value,
): void {
  if (value.startsWith("/") || isWindowsDrivePath(value)) {
    throw new Error(`${label} must be relative: ${reportedValue}`);
  }
  if (value.includes("\\")) {
    throw new Error(`${label} must use forward slashes: ${reportedValue}`);
  }
}

function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/u, "");
}

export function normalizeArchivePath(entryPath: string, label: string): string {
  const trimmed = stripTrailingSlashes(entryPath.trim());
  if (!trimmed) {
    throw new Error(`${label} is empty.`);
  }
  assertPortableRelativePathSyntax(trimmed, label, entryPath);
  if (trimmed.split("/").some((segment) => segment === "." || segment === "..")) {
    throw new Error(`${label} contains path traversal segments: ${entryPath}`);
  }

  const normalized = stripTrailingSlashes(path.posix.normalize(trimmed));
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw new Error(`${label} resolves outside the archive root: ${entryPath}`);
  }
  return normalized;
}

export function normalizeArchiveRoot(rootName: string): string {
  const normalized = normalizeArchivePath(rootName, "Backup manifest archiveRoot");
  if (normalized.includes("/")) {
    throw new Error(`Backup manifest archiveRoot must be a single path segment: ${rootName}`);
  }
  return normalized;
}

export function isArchivePathWithin(child: string, parent: string): boolean {
  const relative = path.posix.relative(parent, child);
  return relative === "" || (!relative.startsWith("../") && relative !== "..");
}

export function assertArchiveSymbolicLinkTarget(params: {
  archiveRoot: string;
  entryPath: string;
  linkpath?: string;
  assets: readonly { archivePath: string }[];
}): void {
  if (!params.linkpath) {
    throw new Error(`Archive symbolic link is missing its target: ${params.entryPath}`);
  }
  assertPortableRelativePathSyntax(
    params.linkpath,
    "Archive symbolic link target",
    `${params.entryPath} -> ${params.linkpath}`,
  );
  const entryPath = normalizeArchivePath(params.entryPath, "Archive symbolic link path");
  const targetPath = path.posix.normalize(
    path.posix.join(path.posix.dirname(entryPath), params.linkpath),
  );
  if (!isArchivePathWithin(targetPath, normalizeArchiveRoot(params.archiveRoot))) {
    throw new Error(
      `Archive symbolic link target is outside the declared archive root: ${params.entryPath} -> ${params.linkpath}`,
    );
  }
  const insideDeclaredAsset = (linkPath: string) =>
    params.assets.some(({ archivePath: assetPath }) =>
      isArchivePathWithin(linkPath, normalizeArchivePath(assetPath, "Backup manifest asset path")),
    );
  if (!insideDeclaredAsset(entryPath) || !insideDeclaredAsset(targetPath)) {
    throw new Error(
      `Archive symbolic link is outside the declared backup assets: ${params.entryPath} -> ${params.linkpath}`,
    );
  }
}

// Every target `assertPortableRelativePathSyntax` refuses as non-relative.
// `isWindowsDrivePath` folds backslashes into slashes, splits on `/`, and matches
// any segment against /^[a-zA-Z]:/, so this set is wider than "absolute on this
// platform": it also holds rooted and drive spellings, and relative POSIX targets
// with a colon in a segment such as `sub/x:1`. Matching the guard's set exactly is
// the point — create classifies precisely the targets verification would refuse,
// so no target reaches the archive on one side and is rejected on the other.
function isNonRelativeSymbolicLinkTarget(linkpath: string): boolean {
  return path.isAbsolute(linkpath) || linkpath.startsWith("/") || isWindowsDrivePath(linkpath);
}

/** Whether a non-relative state link target could still become a portable archive target. */
function isRemappableAbsoluteSymbolicLinkTarget(linkpath: string | undefined): linkpath is string {
  // A backslash-bearing target has no unambiguous archive spelling, because the
  // payload encoder folds `\` into `/`, so it is never rewritten even when a
  // declared asset owns it. That link stays with the archive guard.
  return (
    linkpath !== undefined && isNonRelativeSymbolicLinkTarget(linkpath) && !linkpath.includes("\\")
  );
}

/**
 * One create run's link-target ownership answers, keyed by raw link target.
 * Valid only for a single run: the answer depends on the asset set, which is
 * fixed there, and on filesystem state, which the run treats as stable.
 */
export type DeclaredSymbolicLinkTargetCache = Map<string, string | undefined>;

// Tar exposes the first link hop, while assets own the final canonical path.
// Resolve before containment so chains map to one portable archive target.
function resolveDeclaredSymbolicLinkTargetSourcePath(
  linkpath: string,
  assets: readonly BackupAsset[],
  ownedTargets?: DeclaredSymbolicLinkTargetCache,
): string | undefined {
  // `realpathSync` resolves a relative target against `process.cwd()`, not against
  // the link's own directory, so a target that is relative on this platform must
  // never reach the filesystem: the verdict would follow the operator's shell, and
  // a target that happened to resolve under the cwd would be rewritten to name
  // content the source link never pointed at. Refusing here leaves such a target
  // ownerless by construction, which is the same verdict from every cwd.
  if (!path.isAbsolute(linkpath)) {
    return undefined;
  }
  if (ownedTargets?.has(linkpath)) {
    return ownedTargets.get(linkpath);
  }
  const resolveOwnedTargetSourcePath = (): string | undefined => {
    let targetSourcePath: string;
    try {
      targetSourcePath = realpathSync(linkpath);
    } catch {
      return undefined;
    }
    return assets.some((asset) => isPathWithin(targetSourcePath, asset.sourcePath))
      ? targetSourcePath
      : undefined;
  };
  const ownedTargetSourcePath = resolveOwnedTargetSourcePath();
  ownedTargets?.set(linkpath, ownedTargetSourcePath);
  return ownedTargetSourcePath;
}

/** Rewrite an absolute link target owned by a declared asset into an archive-relative one. */
export function remapDeclaredAbsoluteSymbolicLinkTarget(params: {
  linkpath: string | undefined;
  archiveEntryPath: string;
  archiveRoot: string;
  assets: readonly BackupAsset[];
  ownedTargets?: DeclaredSymbolicLinkTargetCache;
}): string | undefined {
  if (!isRemappableAbsoluteSymbolicLinkTarget(params.linkpath)) {
    return params.linkpath;
  }
  const targetSourcePath = resolveDeclaredSymbolicLinkTargetSourcePath(
    params.linkpath,
    params.assets,
    params.ownedTargets,
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
 * Whether no archive can carry this link and no restore could recreate it, so
 * creation omits and reports it instead of failing the whole backup. Every link
 * that is archived still passes `assertArchiveSymbolicLinkTarget`.
 *
 * Only the spellings `assertPortableRelativePathSyntax` refuses qualify, and the
 * asymmetry with an escaping relative target is the point rather than an
 * oversight. A refused spelling has no archive target to be written at all, and an
 * absolute one also resolves outside any restore tree, so omitting the link loses
 * nothing a stricter policy would have kept. A relative escape the guard accepts
 * syntactically _would_ resolve to a path inside or beside the restored tree — the
 * substitution hazard this module's archive guard exists to prevent — so an
 * escaping relative link still fails creation.
 *
 * Restorability is a wider question than remappability, so the two do not share a
 * predicate. Ownership decides restorability: whatever the spelling, an unowned
 * absolute target has no archive path to point at. Spelling decides
 * remappability: a backslash-bearing target has no unambiguous archive spelling.
 * A backslash target a declared asset _does_ own is therefore restorable and
 * still stays with the guard: the payload encoder folds backslashes into slashes
 * (`buildBackupArchivePath`), so `dir/a\b` and `dir/a/b` share one archive path
 * and an archived link cannot say which of the two it means.
 */
export function isUnrestorableSymbolicLinkTarget(
  linkpath: string,
  assets: readonly BackupAsset[],
  ownedTargets?: DeclaredSymbolicLinkTargetCache,
): boolean {
  if (!isNonRelativeSymbolicLinkTarget(linkpath)) {
    return false;
  }
  return !resolveDeclaredSymbolicLinkTargetSourcePath(linkpath, assets, ownedTargets);
}
