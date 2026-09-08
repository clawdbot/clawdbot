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
import { isNotFoundPathError, isPathInside } from "../infra/path-guards.js";
import { resolvePreferredOpenClawTmpDir } from "../infra/tmp-openclaw-dir.js";
import { resolveConfigDir, shortenHomePath } from "../utils.js";

const DATA_URL_RE = /^data:/i;
const SANDBOX_CONTAINER_WORKDIR = "/workspace";
const MANAGED_MEDIA_SUBDIRS = new Set(["outbound"]);

function normalizeAtPrefix(filePath: string): string {
  return filePath.startsWith("@") ? filePath.slice(1) : filePath;
}

function expandPath(filePath: string): string {
  const normalized = normalizeAtPrefix(filePath);
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

const realpathNative = promisify(fs.realpath.native);

async function resolveRawPathViaExistingAncestor(rawPath: string): Promise<string> {
  let cursor = rawPath;
  const missingSuffix: string[] = [];
  while (true) {
    try {
      return path.resolve(await realpathNative(cursor), ...missingSuffix);
    } catch (error) {
      if (!isNotFoundPathError(error)) {
        throw error;
      }
      const parent = path.dirname(cursor);
      if (parent === cursor) {
        throw error;
      }
      missingSuffix.unshift(path.basename(cursor));
      cursor = parent;
    }
  }
}

async function assertRawParentWithinRoot(params: {
  filePath: string;
  cwd: string;
  root: string;
  rootCanonical: string;
}): Promise<{ rootCanonical: string; targetCanonical: string }> {
  // Win32 resolves reparse-point/.. paths lexically, so it has no equivalent escape.
  // Avoid adding another realpath to this hot path on Windows, where it is expensive.
  if (process.platform === "win32") {
    return {
      rootCanonical: path.resolve(params.root),
      targetCanonical: resolveSandboxInputPath(params.filePath, params.cwd),
    };
  }
  const expanded = expandPath(params.filePath);
  if (isWindowsDrivePath(expanded)) {
    return {
      rootCanonical: path.resolve(params.root),
      targetCanonical: path.win32.normalize(expanded),
    };
  }
  // Do not use path.resolve here: it would erase the symlink-sensitive `..` before
  // native realpath can traverse the raw parent chain. The final component stays
  // unresolved so assertNoPathAliasEscape retains final-link policy ownership.
  const rawAbsolute = path.isAbsolute(expanded) ? expanded : `${params.cwd}${path.sep}${expanded}`;
  const hasTrailingSeparator = rawAbsolute.endsWith(path.sep);
  const rawParent = hasTrailingSeparator ? rawAbsolute : path.dirname(rawAbsolute);
  const finalSegment = hasTrailingSeparator ? "." : path.basename(rawAbsolute);
  const rootResolved = path.resolve(params.root);
  const { rootCanonical } = params;
  const parentCanonical = await resolveRawPathViaExistingAncestor(rawParent);
  const targetCanonical =
    path.resolve(rawAbsolute) === rootResolved
      ? await resolveRawPathViaExistingAncestor(rawAbsolute)
      : path.resolve(parentCanonical, finalSegment);
  if (targetCanonical !== rootCanonical && !isPathInside(rootCanonical, targetCanonical)) {
    throw new Error(
      `Path escapes sandbox root (${shortenHomePath(rootCanonical)}): ${params.filePath}`,
    );
  }
  return { rootCanonical, targetCanonical };
}

export async function assertSandboxPath(params: {
  filePath: string;
  cwd: string;
  root: string;
  allowFinalSymlinkForUnlink?: boolean;
  allowFinalHardlinkForUnlink?: boolean;
}) {
  const root = path.resolve(params.root);
  const cwd = path.resolve(params.cwd);
  let rootCanonical = root;
  let resolutionCwd = cwd;
  let filePath = params.filePath;
  const expanded = expandPath(filePath);
  if (process.platform !== "win32" && !isWindowsDrivePath(expanded)) {
    const rootPromise = resolveRawPathViaExistingAncestor(root);
    const [canonicalRoot, canonicalCwd] = await Promise.all([
      rootPromise,
      cwd === root ? rootPromise : resolveRawPathViaExistingAncestor(cwd),
    ]);
    rootCanonical = canonicalRoot;
    resolutionCwd = path.resolve(root, path.relative(rootCanonical, canonicalCwd));
    // Only caller-owned prefixes may change spelling. Canonicalizing the input
    // itself would admit unrelated external links pointing into the workspace.
    const prefixes: [string, string][] = [
      [cwd, resolutionCwd],
      [root, root],
      [rootCanonical, root],
    ];
    if (path.isAbsolute(expanded) && isPathInside(rootCanonical, canonicalCwd)) {
      const rootAlias = path.resolve(cwd, path.relative(canonicalCwd, rootCanonical));
      // Cwd may itself link deeper into the root; its ancestors are trusted only
      // after proving the candidate has the recorded root's canonical identity.
      if (
        !prefixes.some(([prefix]) => prefix === rootAlias) &&
        (await resolveRawPathViaExistingAncestor(rootAlias)) === rootCanonical
      ) {
        prefixes.push([rootAlias, root]);
      }
    }
    for (const [prefix, replacement] of prefixes.toSorted((a, b) => b[0].length - a[0].length)) {
      if (expanded === prefix) {
        filePath = replacement;
        break;
      }
      const prefixWithSeparator = prefix.endsWith(path.sep) ? prefix : `${prefix}${path.sep}`;
      if (expanded.startsWith(prefixWithSeparator)) {
        // Preserve raw '..' and trailing separators for the path guards below.
        const separator = replacement.endsWith(path.sep) ? "" : path.sep;
        filePath = `${replacement}${separator}${expanded.slice(prefixWithSeparator.length)}`;
        break;
      }
    }
  }
  const normalized = { filePath, cwd: resolutionCwd, root, rootCanonical };
  const resolved = resolveSandboxPath(normalized);
  const policy: PathAliasPolicy = {
    allowFinalSymlinkForUnlink: params.allowFinalSymlinkForUnlink,
    allowFinalHardlinkForUnlink: params.allowFinalHardlinkForUnlink,
  };
  await assertNoPathAliasEscape({
    absolutePath: resolved.resolved,
    rootPath: root,
    boundaryLabel: "sandbox root",
    policy,
  });
  // Also check raw parents: absolute input can enter the root only after a
  // symlink/.. prefix outside it, which the alias guard normalizes away.
  const rawTarget = await assertRawParentWithinRoot(normalized);
  if (path.resolve(rawTarget.targetCanonical) !== path.resolve(resolved.resolved)) {
    await assertNoPathAliasEscape({
      absolutePath: rawTarget.targetCanonical,
      rootPath: rawTarget.rootCanonical,
      boundaryLabel: "sandbox root",
      policy,
    });
  }
  return resolved;
}

export function assertMediaNotDataUrl(media: string): void {
  const raw = media.trim();
  if (DATA_URL_RE.test(raw)) {
    throw new Error("data: URLs are not supported for media. Use buffer instead.");
  }
}

export function resolveManagedMediaRoot(candidate: string): string | undefined {
  const expanded = expandPath(candidate);
  if (!hostPathLooksAbsolute(expanded)) {
    return undefined;
  }
  const mediaRoot = path.join(resolveConfigDir(), "media");
  const resolvedMediaRoot = path.resolve(mediaRoot);
  const resolvedExpanded = path.resolve(expanded);
  if (
    resolvedExpanded === resolvedMediaRoot ||
    !isPathInside(resolvedMediaRoot, resolvedExpanded)
  ) {
    return undefined;
  }
  const relative = path.relative(resolvedMediaRoot, resolvedExpanded);
  const firstSegment = relative.split(path.sep)[0] ?? "";
  return MANAGED_MEDIA_SUBDIRS.has(firstSegment) || firstSegment.startsWith("tool-")
    ? path.join(resolvedMediaRoot, firstSegment)
    : undefined;
}

export async function resolveAllowedManagedMediaPath(
  candidate: string,
): Promise<string | undefined> {
  const expanded = expandPath(candidate);
  if (!resolveManagedMediaRoot(expanded)) {
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
  containerWorkdir?: string;
}): Promise<string> {
  const raw = params.media.trim();
  if (!raw) {
    return raw;
  }
  if (isPassThroughRemoteMediaSource(raw)) {
    return raw;
  }
  const normalizedContainerWorkdir = path.posix.normalize(
    (params.containerWorkdir ?? SANDBOX_CONTAINER_WORKDIR).replace(/\\/g, "/"),
  );
  const containerWorkdir = normalizedContainerWorkdir.replace(/\/+$/, "") || "/";
  let candidate = raw;
  if (/^file:/i.test(candidate)) {
    const workspaceMappedFromUrl = mapContainerWorkspaceFileUrl({
      fileUrl: candidate,
      sandboxRoot: params.sandboxRoot,
      containerWorkdir,
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
    containerWorkdir,
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
  containerWorkdir: string;
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
  // Backend workdirs are container paths; parse the URL directly so Windows hosts
  // can still map Linux-style file URLs to their actual sandbox workspace.
  let normalizedPathname: string;
  try {
    normalizedPathname = decodeURIComponent(parsed.pathname).replace(/\\/g, "/");
  } catch {
    return undefined;
  }
  return mapContainerWorkspacePath({
    candidate: normalizedPathname,
    sandboxRoot: params.sandboxRoot,
    containerWorkdir: params.containerWorkdir,
  });
}

function mapContainerWorkspacePath(params: {
  candidate: string;
  sandboxRoot: string;
  containerWorkdir: string;
}): string | undefined {
  const normalized = params.candidate.replace(/\\/g, "/");
  if (normalized === params.containerWorkdir) {
    return path.resolve(params.sandboxRoot);
  }
  const prefix = params.containerWorkdir === "/" ? "/" : `${params.containerWorkdir}/`;
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
