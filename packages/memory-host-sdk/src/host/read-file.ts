import fs from "node:fs/promises";
import path from "node:path";
import {
  resolveAgentContextLimits,
  resolveAgentWorkspaceDir,
  resolveMemorySearchConfig,
  type OpenClawConfig,
} from "./config-utils.js";
import {
  assertNoSymlinkParents,
  isFileMissingError,
  isPathInside,
  isPathInsideWithRealpath,
  readRegularFile,
  root,
  statRegularFile,
} from "./fs-utils.js";
import { isMemoryPath, normalizeExtraMemoryPaths } from "./internal.js";
import {
  buildMemoryReadResult,
  DEFAULT_MEMORY_READ_LINES,
  type MemoryReadResult,
} from "./read-file-shared.js";
import { retryTransientMemoryRead } from "./read-retry.js";

// Secure markdown memory-file reader for workspace and configured extra paths.

/** Check that an absolute path stays inside an allowed extra directory without symlink escapes. */
async function isAllowedAdditionalDirectoryPath(
  additionalPath: string,
  absPath: string,
): Promise<boolean> {
  if (!isPathInside(additionalPath, absPath)) {
    return false;
  }
  try {
    await assertNoSymlinkParents({ rootDir: additionalPath, targetPath: absPath });
  } catch {
    return false;
  }
  if (!isPathInsideWithRealpath(additionalPath, absPath)) {
    try {
      await fs.lstat(absPath);
    } catch (err) {
      return isFileMissingError(err);
    }
    return false;
  }
  return true;
}

/** Return true when a file vanished after path validation but before content read. */
function isFileDisappearedDuringReadError(err: unknown): boolean {
  return (
    isFileMissingError(err) ||
    Boolean(
      err &&
      typeof err === "object" &&
      "code" in err &&
      (err as { code?: unknown }).code === "path-mismatch",
    )
  );
}

/** Read a validated memory markdown file from workspace or configured extra paths. */
export async function readMemoryFile(params: {
  workspaceDir: string;
  extraPaths?: string[];
  relPath: string;
  from?: number;
  lines?: number;
  defaultLines?: number;
  maxChars?: number;
}): Promise<MemoryReadResult> {
  const rawPath = params.relPath.trim();
  if (!rawPath) {
    throw new Error("path required");
  }
  const absPath = path.isAbsolute(rawPath)
    ? path.resolve(rawPath)
    : path.resolve(params.workspaceDir, rawPath);
  const relPath = path.relative(params.workspaceDir, absPath).replace(/\\/g, "/");
  const inWorkspace = relPath.length > 0 && !relPath.startsWith("..") && !path.isAbsolute(relPath);
  const allowedWorkspace = inWorkspace && isMemoryPath(relPath);
  let allowedAdditional = false;
  if (!allowedWorkspace && (params.extraPaths?.length ?? 0) > 0) {
    const additionalPaths = normalizeExtraMemoryPaths(params.workspaceDir, params.extraPaths);
    for (const additionalPath of additionalPaths) {
      try {
        const stat = await fs.lstat(additionalPath);
        if (stat.isSymbolicLink()) {
          continue;
        }
        if (stat.isDirectory()) {
          if (await isAllowedAdditionalDirectoryPath(additionalPath, absPath)) {
            const candidateStat = await fs.lstat(absPath).catch(() => null);
            if (candidateStat?.isSymbolicLink()) {
              continue;
            }
            allowedAdditional = true;
            break;
          }
          continue;
        }
        if (stat.isFile() && absPath === additionalPath && absPath.endsWith(".md")) {
          allowedAdditional = true;
          break;
        }
      } catch {}
    }
  }
  if (!allowedWorkspace && !allowedAdditional) {
    throw new Error("path required");
  }
  if (!absPath.endsWith(".md")) {
    throw new Error("path required");
  }
  if (allowedWorkspace) {
    try {
      // Workspace reads use the safe fs root so symlink escapes are rejected before file IO.
      const workspaceRoot = await root(params.workspaceDir);
      await workspaceRoot.resolve(relPath);
    } catch (err) {
      if (isFileMissingError(err)) {
        return { text: "", path: relPath };
      }
      throw err;
    }
  }
  const statResult = await statRegularFile(absPath);
  if (statResult.missing) {
    return { text: "", path: relPath };
  }
  let content: string;
  try {
    content = (
      await retryTransientMemoryRead(
        () => readRegularFile({ filePath: absPath }),
        `read memory file ${absPath}`,
      )
    ).buffer.toString("utf-8");
  } catch (err) {
    if (isFileDisappearedDuringReadError(err)) {
      return { text: "", path: relPath };
    }
    throw err;
  }
  return buildMemoryReadResult({
    content,
    relPath,
    from: params.from,
    lines: params.lines,
    defaultLines: params.defaultLines ?? DEFAULT_MEMORY_READ_LINES,
    maxChars: params.maxChars,
    suggestReadFallback: allowedWorkspace,
  });
}

/** Resolve agent memory config and read one memory file for that agent. */
export async function readAgentMemoryFile(params: {
  cfg: OpenClawConfig;
  agentId: string;
  relPath: string;
  from?: number;
  lines?: number;
}): Promise<MemoryReadResult> {
  const settings = resolveMemorySearchConfig(params.cfg, params.agentId);
  if (!settings) {
    throw new Error("memory search disabled");
  }
  const contextLimits = resolveAgentContextLimits(params.cfg, params.agentId);
  return await readMemoryFile({
    workspaceDir: resolveAgentWorkspaceDir(params.cfg, params.agentId),
    extraPaths: settings.extraPaths,
    relPath: params.relPath,
    from: params.from,
    lines: params.lines,
    defaultLines: contextLimits?.memoryGetDefaultLines,
    maxChars: contextLimits?.memoryGetMaxChars,
  });
}
