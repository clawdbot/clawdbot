import { randomBytes } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import path from "node:path";
import { resolveUserPath } from "../utils.js";
import { openVerifiedFileSync } from "./safe-open-sync.js";

export const DEFAULT_SECRET_FILE_MAX_BYTES = 16 * 1024;
export const PRIVATE_SECRET_DIR_MODE = 0o700;
export const PRIVATE_SECRET_FILE_MODE = 0o600;

export type SecretFileReadOptions = {
  maxBytes?: number;
  rejectSymlink?: boolean;
};

export type SecretFileReadResult =
  | {
      ok: true;
      secret: string;
      resolvedPath: string;
    }
  | {
      ok: false;
      message: string;
      resolvedPath?: string;
      error?: unknown;
    };

function normalizeSecretReadError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

export function loadSecretFileSync(
  filePath: string,
  label: string,
  options: SecretFileReadOptions = {},
): SecretFileReadResult {
  const trimmedPath = filePath.trim();
  const resolvedPath = resolveUserPath(trimmedPath);
  if (!resolvedPath) {
    return { ok: false, message: `${label} file path is empty.` };
  }

  const maxBytes = options.maxBytes ?? DEFAULT_SECRET_FILE_MAX_BYTES;

  let previewStat: fs.Stats;
  try {
    previewStat = fs.lstatSync(resolvedPath);
  } catch (error) {
    const normalized = normalizeSecretReadError(error);
    return {
      ok: false,
      resolvedPath,
      error: normalized,
      message: `Failed to inspect ${label} file at ${resolvedPath}: ${String(normalized)}`,
    };
  }

  if (options.rejectSymlink && previewStat.isSymbolicLink()) {
    return {
      ok: false,
      resolvedPath,
      message: `${label} file at ${resolvedPath} must not be a symlink.`,
    };
  }
  if (!previewStat.isFile()) {
    return {
      ok: false,
      resolvedPath,
      message: `${label} file at ${resolvedPath} must be a regular file.`,
    };
  }
  if (previewStat.size > maxBytes) {
    return {
      ok: false,
      resolvedPath,
      message: `${label} file at ${resolvedPath} exceeds ${maxBytes} bytes.`,
    };
  }

  const opened = openVerifiedFileSync({
    filePath: resolvedPath,
    rejectPathSymlink: options.rejectSymlink,
    maxBytes,
  });
  if (!opened.ok) {
    const error = normalizeSecretReadError(
      opened.reason === "validation" ? new Error("security validation failed") : opened.error,
    );
    return {
      ok: false,
      resolvedPath,
      error,
      message: `Failed to read ${label} file at ${resolvedPath}: ${String(error)}`,
    };
  }

  try {
    const raw = fs.readFileSync(opened.fd, "utf8");
    const secret = raw.trim();
    if (!secret) {
      return {
        ok: false,
        resolvedPath,
        message: `${label} file at ${resolvedPath} is empty.`,
      };
    }
    return { ok: true, secret, resolvedPath };
  } catch (error) {
    const normalized = normalizeSecretReadError(error);
    return {
      ok: false,
      resolvedPath,
      error: normalized,
      message: `Failed to read ${label} file at ${resolvedPath}: ${String(normalized)}`,
    };
  } finally {
    fs.closeSync(opened.fd);
  }
}

export function readSecretFileSync(
  filePath: string,
  label: string,
  options: SecretFileReadOptions = {},
): string {
  const result = loadSecretFileSync(filePath, label, options);
  if (result.ok) {
    return result.secret;
  }
  throw new Error(result.message, result.error ? { cause: result.error } : undefined);
}

export function tryReadSecretFileSync(
  filePath: string | undefined,
  label: string,
  options: SecretFileReadOptions = {},
): string | undefined {
  if (!filePath?.trim()) {
    return undefined;
  }
  const result = loadSecretFileSync(filePath, label, options);
  return result.ok ? result.secret : undefined;
}

function assertPathWithinRoot(rootDir: string, targetPath: string): void {
  const relative = path.relative(rootDir, targetPath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Private secret path must stay under ${rootDir}.`);
  }
}

function assertRealPathWithinRoot(rootDir: string, targetPath: string): void {
  const relative = path.relative(rootDir, targetPath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Private secret path must stay under ${rootDir}.`);
  }
}

async function enforcePrivatePathMode(
  resolvedPath: string,
  expectedMode: number,
  kind: "directory" | "file",
): Promise<void> {
  if (process.platform === "win32") {
    return;
  }
  await fsp.chmod(resolvedPath, expectedMode);
  const stat = await fsp.stat(resolvedPath);
  const actualMode = stat.mode & 0o777;
  if (actualMode !== expectedMode) {
    throw new Error(
      `Private secret ${kind} ${resolvedPath} has insecure permissions ${actualMode.toString(8)}.`,
    );
  }
}

async function ensurePrivateDirectory(rootDir: string, targetDir: string): Promise<void> {
  const resolvedRoot = path.resolve(rootDir);
  const resolvedTarget = path.resolve(targetDir);
  if (resolvedTarget === resolvedRoot) {
    await fsp.mkdir(resolvedRoot, { recursive: true, mode: PRIVATE_SECRET_DIR_MODE });
    const rootStat = await fsp.lstat(resolvedRoot);
    if (rootStat.isSymbolicLink()) {
      throw new Error(`Private secret root ${resolvedRoot} must not be a symlink.`);
    }
    if (!rootStat.isDirectory()) {
      throw new Error(`Private secret root ${resolvedRoot} must be a directory.`);
    }
    await enforcePrivatePathMode(resolvedRoot, PRIVATE_SECRET_DIR_MODE, "directory");
    return;
  }

  assertPathWithinRoot(resolvedRoot, resolvedTarget);
  await ensurePrivateDirectory(resolvedRoot, resolvedRoot);
  const resolvedRootReal = await fsp.realpath(resolvedRoot);

  let current = resolvedRoot;
  for (const segment of path
    .relative(resolvedRoot, resolvedTarget)
    .split(path.sep)
    .filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const stat = await fsp.lstat(current);
      if (stat.isSymbolicLink()) {
        throw new Error(`Private secret directory component ${current} must not be a symlink.`);
      }
      if (!stat.isDirectory()) {
        throw new Error(`Private secret directory component ${current} must be a directory.`);
      }
    } catch (error) {
      if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") {
        throw error;
      }
      await fsp.mkdir(current, { mode: PRIVATE_SECRET_DIR_MODE });
    }
    const currentReal = await fsp.realpath(current);
    assertRealPathWithinRoot(resolvedRootReal, currentReal);
    await enforcePrivatePathMode(currentReal, PRIVATE_SECRET_DIR_MODE, "directory");
  }
}

export async function writePrivateSecretFileAtomic(params: {
  rootDir: string;
  filePath: string;
  content: string | Uint8Array;
}): Promise<void> {
  const resolvedRoot = path.resolve(params.rootDir);
  const resolvedFile = path.resolve(params.filePath);
  assertPathWithinRoot(resolvedRoot, resolvedFile);
  const intendedParentDir = path.dirname(resolvedFile);
  await ensurePrivateDirectory(resolvedRoot, intendedParentDir);
  const resolvedRootReal = await fsp.realpath(resolvedRoot);
  const parentDir = await fsp.realpath(intendedParentDir);
  assertRealPathWithinRoot(resolvedRootReal, parentDir);
  const fileName = path.basename(resolvedFile);
  const finalFilePath = path.join(parentDir, fileName);

  try {
    const stat = await fsp.lstat(finalFilePath);
    if (stat.isSymbolicLink()) {
      throw new Error(`Private secret file ${finalFilePath} must not be a symlink.`);
    }
    if (!stat.isFile()) {
      throw new Error(`Private secret file ${finalFilePath} must be a regular file.`);
    }
  } catch (error) {
    if (!error || typeof error !== "object" || !("code" in error) || error.code !== "ENOENT") {
      throw error;
    }
  }

  const tempPath = path.join(
    parentDir,
    `.tmp-${process.pid}-${Date.now()}-${randomBytes(6).toString("hex")}`,
  );
  let createdTemp = false;
  try {
    const handle = await fsp.open(tempPath, "wx", PRIVATE_SECRET_FILE_MODE);
    createdTemp = true;
    try {
      await handle.writeFile(params.content);
    } finally {
      await handle.close();
    }
    await enforcePrivatePathMode(tempPath, PRIVATE_SECRET_FILE_MODE, "file");
    const refreshedParentReal = await fsp.realpath(intendedParentDir);
    if (refreshedParentReal !== parentDir) {
      throw new Error(`Private secret parent directory changed during write for ${finalFilePath}.`);
    }
    await fsp.rename(tempPath, finalFilePath);
    createdTemp = false;
    await enforcePrivatePathMode(finalFilePath, PRIVATE_SECRET_FILE_MODE, "file");
  } finally {
    if (createdTemp) {
      await fsp.unlink(tempPath).catch(() => undefined);
    }
  }
}
