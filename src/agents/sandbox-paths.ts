/**
 * Sandbox input path normalization and boundary checks.
 *
 * Handles host paths, file URLs, temporary media paths, and workspace root assertions.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { URL } from "node:url";
import { promisify } from "node:util";
import { isPassThroughRemoteMediaSource } from "@openclaw/media-core/media-source-url";
import { isWindowsDrivePath } from "../infra/archive-path.js";
import {
  assertNoWindowsNetworkPath,
  hasEncodedFileUrlSeparator,
  safeFileURLToPath,
} from "../infra/local-file-access.js";
import { assertNoPathAliasEscape, type PathAliasPolicy } from "../infra/path-alias-guards.js";
import { isPathInside } from "../infra/path-guards.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { resolveConfigDir, shortenHomePath } from "../utils.js";

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;
const DATA_URL_RE = /^data:/i;
const SANDBOX_CONTAINER_WORKDIR = "/workspace";
const MANAGED_MEDIA_SUBDIRS = new Set(["outbound"]);

function normalizeUnicodeSpaces(str: string): string {
  return str.replace(UNICODE_SPACES, " ");
}

function normalizeAtPrefix(filePath: string): string {
  return filePath.startsWith("@") ? filePath.slice(1) : filePath;
}

function expandPath(filePath: string): string {
  const normalized = normalizeUnicodeSpaces(normalizeAtPrefix(filePath));
  if (normalized === "~") {
    return os.homedir();
  }
  if (normalized.startsWith("~/")) {
    return os.homedir() + normalized.slice(1);
  }
  return normalized;
}

/** True when the path is absolute for the current platform or a Windows drive path (e.g. C:\\...), even if path.isAbsolute is false under POSIX rules. */
function hostPathLooksAbsolute(expanded: string): boolean {
  return path.isAbsolute(expanded) || isWindowsDrivePath(expanded);
}

function resolveToCwd(filePath: string, cwd: string): string {
  const expanded = expandPath(filePath);
  // Drive-letter paths first: on Unix path.isAbsolute is false for C:/...; on Windows we still normalize.
  if (isWindowsDrivePath(expanded)) {
    return path.win32.normalize(expanded);
  }
  if (path.isAbsolute(expanded)) {
    return expanded;
  }
  return path.resolve(cwd, expanded);
}

export function resolveSandboxInputPath(filePath: string, cwd: string): string {
  return resolveToCwd(filePath, cwd);
}

export function resolveSandboxPath(params: { filePath: string; cwd: string; root: string }): {
  resolved: string;
  relative: string;
} {
  const resolved = resolveSandboxInputPath(params.filePath, params.cwd);
  const rootResolved = path.resolve(params.root);
  const relative = path.relative(rootResolved, resolved);
  if (!relative || relative === "") {
    return { resolved, relative: "" };
  }
  if (
    relative === ".." ||
    relative.startsWith("../") ||
    relative.startsWith("..\\") ||
    path.isAbsolute(relative) ||
    isWindowsDrivePath(relative)
  ) {
    throw new Error(
      `Path escapes sandbox root (${shortenHomePath(rootResolved)}): ${params.filePath}`,
    );
  }
  return { resolved, relative };
}

// OS realpath honors symlinks per-component. Node's JS `fs.realpathSync` and
// `path.resolve` instead collapse `..` lexically BEFORE resolving symlinks, so a
// `symlink/..` sequence resolves to a different (in-root, harmless) path than the
// OS produces — which is exactly the boundary bypass `assertRawParentWithinRoot`
// guards against. The native realpath is therefore mandatory here.
const realpathNative = promisify(fs.realpath.native);

/**
 * Resolve the deepest existing ancestor of a raw, non-lexically-collapsed path
 * via the OS realpath, re-appending any not-yet-existing trailing segments.
 */
async function realpathExistingAncestorNative(rawAbsolute: string): Promise<string> {
  let cursor = rawAbsolute;
  const missing: string[] = [];
  for (let guard = 0; guard < 8192; guard += 1) {
    try {
      const real = await realpathNative(cursor);
      return missing.length > 0 ? path.join(real, ...missing.toReversed()) : real;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") {
        throw err;
      }
      const sep = cursor.lastIndexOf(path.sep);
      if (sep < 0) {
        return path.resolve(rawAbsolute);
      }
      const parent = cursor.slice(0, sep);
      if (!parent || parent === cursor) {
        return path.resolve(rawAbsolute);
      }
      missing.push(cursor.slice(sep + 1));
      cursor = parent;
    }
  }
  return path.resolve(rawAbsolute);
}

/**
 * Assert the parent chain of the raw input stays inside the workspace root using
 * the OS realpath (symlink-aware, no lexical `..` pre-collapse). This closes the
 * `symlink/..` bypass that `resolveSandboxPath` (built on `path.resolve`) misses.
 * The final component is intentionally left to `assertNoPathAliasEscape`, which
 * applies the caller's final-symlink/hardlink unlink policy.
 */
async function assertRawParentWithinRoot(params: {
  filePath: string;
  cwd: string;
  root: string;
}): Promise<void> {
  // POSIX-only by design: the symlink-then-`..` escape does not exist on Windows.
  // Win32 path normalization (GetFullPathName) collapses `..` lexically BEFORE
  // traversing a reparse point, so `<symlink>\..\x` resolves to `<symlink-parent>\x`
  // (in-root), not the link target's parent. Verified on Windows 10/11 (Node 22) with
  // both directory symlinks and junctions: the escape read returns ENOENT with no leak,
  // whereas the identical POSIX setup reads the out-of-root file. Running the
  // native-realpath check on Win32 would add over-rejection risk (drive-letter casing,
  // `\\?\` prefixes, 8.3 short names) for no security benefit.
  if (process.platform === "win32") {
    return;
  }
  const expanded = expandPath(params.filePath);
  if (isWindowsDrivePath(expanded)) {
    return;
  }
  const rawAbsolute = path.isAbsolute(expanded) ? expanded : `${params.cwd}${path.sep}${expanded}`;
  const sep = rawAbsolute.lastIndexOf(path.sep);
  const basename = sep >= 0 ? rawAbsolute.slice(sep + 1) : rawAbsolute;
  const rawParent = sep > 0 ? rawAbsolute.slice(0, sep) : path.sep;
  let rootCanonical: string;
  try {
    rootCanonical = await realpathExistingAncestorNative(path.resolve(params.root));
  } catch {
    // If the root itself cannot be canonicalized, fall back to the lexical guards.
    return;
  }
  // Resolve the parent chain (symlinks honored) then re-attach the final
  // component WITHOUT resolving it — a final symlink is the caller's concern via
  // assertNoPathAliasEscape and its unlink policy. "."/".." apply lexically to
  // the already-canonical parent, which is correct once no symlinks remain. This
  // keeps the workspace root itself (target === root, whose real parent is
  // legitimately outside) accepted.
  const parentCanonical = await realpathExistingAncestorNative(rawParent);
  const targetCanonical =
    !basename || basename === "." ? parentCanonical : path.join(parentCanonical, basename);
  if (targetCanonical !== rootCanonical && !isPathInside(rootCanonical, targetCanonical)) {
    throw new Error(
      `Path escapes sandbox root (${shortenHomePath(rootCanonical)}): ${params.filePath}`,
    );
  }
}

export async function assertSandboxPath(params: {
  filePath: string;
  cwd: string;
  root: string;
  allowFinalSymlinkForUnlink?: boolean;
  allowFinalHardlinkForUnlink?: boolean;
}) {
  const resolved = resolveSandboxPath(params);
  const policy: PathAliasPolicy = {
    allowFinalSymlinkForUnlink: params.allowFinalSymlinkForUnlink,
    allowFinalHardlinkForUnlink: params.allowFinalHardlinkForUnlink,
  };
  await assertNoPathAliasEscape({
    absolutePath: resolved.resolved,
    rootPath: params.root,
    boundaryLabel: "sandbox root",
    policy,
  });
  // Runs after the alias-escape check so its (more specific) messages win for the
  // cases it already catches; this closes the residual symlink-then-`..` gap that
  // the lexical `resolveSandboxPath` collapses away and the alias check therefore
  // never sees.
  await assertRawParentWithinRoot(params);
  return resolved;
}

export function assertMediaNotDataUrl(media: string): void {
  const raw = media.trim();
  if (DATA_URL_RE.test(raw)) {
    throw new Error("data: URLs are not supported for media. Use buffer instead.");
  }
}

function isManagedMediaPathUnderRoot(candidate: string): boolean {
  const expanded = expandPath(candidate);
  if (!hostPathLooksAbsolute(expanded)) {
    return false;
  }
  const mediaRoot = path.join(resolveConfigDir(), "media");
  const resolvedMediaRoot = path.resolve(mediaRoot);
  const resolvedExpanded = path.resolve(expanded);
  if (
    resolvedExpanded === resolvedMediaRoot ||
    !isPathInside(resolvedMediaRoot, resolvedExpanded)
  ) {
    return false;
  }
  const relative = path.relative(resolvedMediaRoot, resolvedExpanded);
  const firstSegment = relative.split(path.sep)[0] ?? "";
  return MANAGED_MEDIA_SUBDIRS.has(firstSegment) || firstSegment.startsWith("tool-");
}

export async function resolveAllowedManagedMediaPath(
  candidate: string,
): Promise<string | undefined> {
  const expanded = expandPath(candidate);
  if (!isManagedMediaPathUnderRoot(expanded)) {
    return undefined;
  }
  const resolved = path.resolve(expanded);
  const managedMediaRoot = path.resolve(resolveConfigDir(), "media");
  await assertNoManagedMediaAliasEscape({
    filePath: resolved,
    managedMediaRoot,
  });
  return resolved;
}

export async function resolveSandboxedMediaSource(params: {
  media: string;
  sandboxRoot: string;
}): Promise<string> {
  const raw = params.media.trim();
  if (!raw) {
    return raw;
  }
  if (isPassThroughRemoteMediaSource(raw)) {
    return raw;
  }
  let candidate = raw;
  if (/^file:\/\//i.test(candidate)) {
    const workspaceMappedFromUrl = mapContainerWorkspaceFileUrl({
      fileUrl: candidate,
      sandboxRoot: params.sandboxRoot,
    });
    if (workspaceMappedFromUrl) {
      candidate = workspaceMappedFromUrl;
    } else {
      try {
        candidate = safeFileURLToPath(candidate);
      } catch (err) {
        throw new Error(`Invalid file:// URL for sandboxed media: ${(err as Error).message}`, {
          cause: err,
        });
      }
    }
  }
  const containerWorkspaceMapped = mapContainerWorkspacePath({
    candidate,
    sandboxRoot: params.sandboxRoot,
  });
  if (containerWorkspaceMapped) {
    candidate = containerWorkspaceMapped;
  }
  assertNoWindowsNetworkPath(candidate, "Sandbox media path");
  const tmpMediaPath = await resolveAllowedTmpMediaPath({
    candidate,
    sandboxRoot: params.sandboxRoot,
  });
  if (tmpMediaPath) {
    return tmpMediaPath;
  }
  const managedMediaPath = await resolveAllowedManagedMediaPath(candidate);
  if (managedMediaPath) {
    return managedMediaPath;
  }
  const sandboxResult = await assertSandboxPath({
    filePath: candidate,
    cwd: params.sandboxRoot,
    root: params.sandboxRoot,
  });
  return sandboxResult.resolved;
}

async function assertNoManagedMediaAliasEscape(params: {
  filePath: string;
  managedMediaRoot: string;
}): Promise<void> {
  await assertNoPathAliasEscape({
    absolutePath: params.filePath,
    rootPath: params.managedMediaRoot,
    boundaryLabel: "managed media root",
  });
}

function mapContainerWorkspaceFileUrl(params: {
  fileUrl: string;
  sandboxRoot: string;
}): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(params.fileUrl);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== "file:") {
    return undefined;
  }
  const host = parsed.hostname.trim().toLowerCase();
  if (host && host !== "localhost") {
    return undefined;
  }
  if (hasEncodedFileUrlSeparator(parsed.pathname)) {
    return undefined;
  }
  // Sandbox paths are Linux-style (/workspace/*). Parse the URL path directly so
  // Windows hosts can still accept file:///workspace/... media references.
  let normalizedPathname: string;
  try {
    normalizedPathname = decodeURIComponent(parsed.pathname).replace(/\\/g, "/");
  } catch {
    return undefined;
  }
  if (
    normalizedPathname !== SANDBOX_CONTAINER_WORKDIR &&
    !normalizedPathname.startsWith(`${SANDBOX_CONTAINER_WORKDIR}/`)
  ) {
    return undefined;
  }
  return mapContainerWorkspacePath({
    candidate: normalizedPathname,
    sandboxRoot: params.sandboxRoot,
  });
}

function mapContainerWorkspacePath(params: {
  candidate: string;
  sandboxRoot: string;
}): string | undefined {
  const normalized = params.candidate.replace(/\\/g, "/");
  if (normalized === SANDBOX_CONTAINER_WORKDIR) {
    return path.resolve(params.sandboxRoot);
  }
  const prefix = `${SANDBOX_CONTAINER_WORKDIR}/`;
  if (!normalized.startsWith(prefix)) {
    return undefined;
  }
  const rel = normalized.slice(prefix.length);
  if (!rel) {
    return path.resolve(params.sandboxRoot);
  }
  return path.resolve(params.sandboxRoot, ...rel.split("/").filter(Boolean));
}

async function resolveAllowedTmpMediaPath(params: {
  candidate: string;
  sandboxRoot: string;
}): Promise<string | undefined> {
  const candidateIsAbsolute = hostPathLooksAbsolute(expandPath(params.candidate));
  if (!candidateIsAbsolute) {
    return undefined;
  }
  const resolved = path.resolve(resolveSandboxInputPath(params.candidate, params.sandboxRoot));
  const openClawTmpDir = path.resolve(resolvePreferredOpenClawTmpDir());
  if (!isPathInside(openClawTmpDir, resolved)) {
    return undefined;
  }
  await assertNoTmpAliasEscape({ filePath: resolved, tmpRoot: openClawTmpDir });
  return resolved;
}

async function assertNoTmpAliasEscape(params: {
  filePath: string;
  tmpRoot: string;
}): Promise<void> {
  await assertNoPathAliasEscape({
    absolutePath: params.filePath,
    rootPath: params.tmpRoot,
    boundaryLabel: "tmp root",
  });
}
