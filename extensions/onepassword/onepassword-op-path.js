import fsSync from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { inspectPathPermissions, safeStat } from "@openclaw/fs-safe/permissions";

function errorCode(error) {
  return error && typeof error === "object" && "code" in error ? error.code : undefined;
}

function isTrustedOwner(stat) {
  if (process.platform === "win32" || typeof process.getuid !== "function" || stat.uid == null) {
    return true;
  }
  const uid = process.getuid();
  return stat.uid === uid || stat.uid === 0;
}

async function assertTrustedPath(targetPath) {
  const resolvedPath = await fs.realpath(targetPath);
  const targetStat = await fs.stat(resolvedPath);
  if (!targetStat.isFile()) {
    throw new Error(`path is not a regular file: ${resolvedPath}`);
  }
  await fs.access(resolvedPath, fsSync.constants.X_OK);

  // The CLI receives the service-account token. Validate its resolved parent chain so another
  // local account cannot replace the executable between discovery and a later secret read.
  let currentPath = resolvedPath;
  let first = true;
  for (;;) {
    const [stat, permissions] = await Promise.all([
      safeStat(currentPath),
      inspectPathPermissions(currentPath),
    ]);
    if (!stat.ok || !permissions.ok || permissions.source === "unknown") {
      throw new Error(`permissions could not be verified: ${currentPath}`);
    }
    if ((first && stat.isDir) || (!first && !stat.isDir)) {
      throw new Error(`unexpected path type: ${currentPath}`);
    }
    if (!isTrustedOwner(stat)) {
      throw new Error(`path is not owned by the current user or root: ${currentPath}`);
    }
    const stickyDirectory =
      stat.isDir && permissions.mode != null && (permissions.mode & 0o1000) !== 0;
    if ((permissions.groupWritable || permissions.worldWritable) && !stickyDirectory) {
      throw new Error(`path is writable by another user: ${currentPath}`);
    }

    const parentPath = path.dirname(currentPath);
    if (parentPath === currentPath) {
      break;
    }
    currentPath = parentPath;
    first = false;
  }
  return resolvedPath;
}

export async function resolveTrustedOnePasswordCli(options = {}) {
  const configuredPath = options.configuredPath?.trim();
  if (configuredPath && !path.isAbsolute(configuredPath)) {
    throw new Error(`1Password CLI path must be absolute: ${configuredPath}`);
  }
  const executable = process.platform === "win32" ? "op.exe" : "op";
  const candidates = configuredPath
    ? [configuredPath]
    : (options.pathEnv ?? process.env.PATH ?? "")
        .split(path.delimiter)
        .filter(Boolean)
        .map((directory) => path.resolve(directory, executable));
  let unsafeError;
  for (const candidate of candidates) {
    try {
      return await assertTrustedPath(candidate);
    } catch (error) {
      if (errorCode(error) === "ENOENT" || errorCode(error) === "ENOTDIR") {
        continue;
      }
      unsafeError = new Error(
        `Refusing unsafe 1Password CLI path "${candidate}": ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
      if (configuredPath) {
        throw unsafeError;
      }
    }
  }
  if (unsafeError) {
    throw unsafeError;
  }
  return undefined;
}
