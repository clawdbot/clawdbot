import fs from "node:fs";
import path from "node:path";
import { sameFileIdentity } from "../../infra/fs-safe-advanced.js";
import { tryResolvePathCaseInsensitive } from "../../infra/path-case.js";
import { resolveSessionStorePathCore } from "./paths.js";

const MAX_SYMLINK_HOPS = 64;

function splitPathSegments(value: string): string[] {
  return value.split(path.sep).filter(Boolean);
}

function resolveMissingStorePathIdentity(pathname: string): string | undefined {
  const absolutePath = path.resolve(pathname);
  let resolvedPath = path.parse(absolutePath).root;
  const remaining = splitPathSegments(absolutePath.slice(resolvedPath.length));
  const visitedLinks = new Set<string>();
  let symlinkHops = 0;

  while (remaining.length > 0) {
    const segment = remaining.shift();
    if (!segment || segment === ".") {
      continue;
    }
    if (segment === "..") {
      resolvedPath = path.dirname(resolvedPath);
      continue;
    }
    const candidate = path.join(resolvedPath, segment);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        return undefined;
      }
      try {
        const canonicalAncestor = fs.realpathSync.native(resolvedPath);
        return path.resolve(canonicalAncestor, segment, ...remaining);
      } catch {
        return undefined;
      }
    }
    if (!stat.isSymbolicLink()) {
      resolvedPath = candidate;
      continue;
    }
    const resolutionState = `${candidate}\0${remaining.join(path.sep)}`;
    if (symlinkHops >= MAX_SYMLINK_HOPS || visitedLinks.has(resolutionState)) {
      return undefined;
    }
    visitedLinks.add(resolutionState);
    symlinkHops += 1;
    let target: string;
    try {
      target = fs.readlinkSync(candidate);
    } catch {
      return undefined;
    }
    if (path.isAbsolute(target)) {
      resolvedPath = path.parse(target).root;
      remaining.unshift(...splitPathSegments(target.slice(resolvedPath.length)));
    } else {
      remaining.unshift(...splitPathSegments(target));
    }
  }

  try {
    return fs.realpathSync.native(resolvedPath);
  } catch {
    return undefined;
  }
}

export function isPerAgentSessionStoreConfig(storeConfig: string | undefined): boolean {
  return !storeConfig?.trim() || storeConfig.includes("{agentId}");
}

export function isSameFixedSessionStoreConfig(
  source: string | undefined,
  target: string | undefined,
  env: NodeJS.ProcessEnv,
): boolean {
  if (isPerAgentSessionStoreConfig(source) || isPerAgentSessionStoreConfig(target)) {
    return false;
  }
  const sourcePath = path.resolve(resolveSessionStorePathCore(source, { env }));
  const targetPath = path.resolve(resolveSessionStorePathCore(target, { env }));
  if (sourcePath === targetPath) {
    return true;
  }
  try {
    return sameFileIdentity(
      fs.statSync(sourcePath, { bigint: true }),
      fs.statSync(targetPath, { bigint: true }),
    );
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT" && code !== "ENOTDIR") {
      // An unresolved target may still alias the owned store. Treat that
      // ambiguity as owned so callers fail closed instead of admitting a writer.
      return true;
    }
  }

  const sourceIdentity = resolveMissingStorePathIdentity(sourcePath);
  const targetIdentity = resolveMissingStorePathIdentity(targetPath);
  if (!sourceIdentity || !targetIdentity) {
    return true;
  }
  if (sourceIdentity === targetIdentity) {
    return true;
  }
  if (sourceIdentity.toLowerCase() !== targetIdentity.toLowerCase()) {
    return false;
  }
  const sourceCaseInsensitive = tryResolvePathCaseInsensitive(sourceIdentity);
  const targetCaseInsensitive = tryResolvePathCaseInsensitive(targetIdentity);
  if (sourceCaseInsensitive === false || targetCaseInsensitive === false) {
    return false;
  }
  // Case-equivalent missing paths are owned when the filesystem folds case or
  // when probing cannot prove that the future paths will remain distinct.
  return true;
}
