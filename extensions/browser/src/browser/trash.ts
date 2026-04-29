import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolvePreferredOpenClawTmpDir } from "openclaw/plugin-sdk/temp-path";

const TRASH_DESTINATION_COLLISION_CODES = new Set(["EEXIST", "ENOTEMPTY", "ERR_FS_CP_EEXIST"]);
const TRASH_DESTINATION_RETRY_LIMIT = 4;

function getFsErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) {
    return undefined;
  }
  const code = (error as NodeJS.ErrnoException).code;
  return typeof code === "string" ? code : undefined;
}

function isTrashDestinationCollision(error: unknown): boolean {
  const code = getFsErrorCode(error);
  return Boolean(code && TRASH_DESTINATION_COLLISION_CODES.has(code));
}

function isSameOrChildPath(candidate: string, parent: string): boolean {
  return candidate === parent || candidate.startsWith(`${parent}${path.sep}`);
}

function resolveAllowedTrashRoots(): string[] {
  const roots = [os.homedir(), resolvePreferredOpenClawTmpDir()].map((root) => {
    try {
      return path.resolve(fs.realpathSync.native(root));
    } catch {
      return path.resolve(root);
    }
  });
  return [...new Set(roots)];
}

function assertAllowedTrashTarget(targetPath: string): void {
  let resolvedTargetPath = path.resolve(targetPath);
  try {
    resolvedTargetPath = path.resolve(fs.realpathSync.native(targetPath));
  } catch {
    // The subsequent move will surface missing or inaccessible targets.
  }
  const isAllowed = resolveAllowedTrashRoots().some(
    (root) => resolvedTargetPath !== root && isSameOrChildPath(resolvedTargetPath, root),
  );
  if (!isAllowed) {
    throw new Error(`Refusing to trash path outside allowed roots: ${targetPath}`);
  }
}

function resolveTrashDir(): string {
  const homeDir = os.homedir();
  const trashDir = path.join(homeDir, ".Trash");
  fs.mkdirSync(trashDir, { recursive: true, mode: 0o700 });
  const trashDirStat = fs.lstatSync(trashDir);
  if (!trashDirStat.isDirectory() || trashDirStat.isSymbolicLink()) {
    throw new Error(`Refusing to use non-directory/symlink trash directory: ${trashDir}`);
  }
  const realHome = path.resolve(fs.realpathSync.native(homeDir));
  const resolvedTrashDir = path.resolve(fs.realpathSync.native(trashDir));
  if (resolvedTrashDir === realHome || !isSameOrChildPath(resolvedTrashDir, realHome)) {
    throw new Error(`Trash directory escaped home directory: ${trashDir}`);
  }
  return resolvedTrashDir;
}

function trashBaseName(targetPath: string): string {
  const resolvedTargetPath = path.resolve(targetPath);
  if (resolvedTargetPath === path.parse(resolvedTargetPath).root) {
    throw new Error(`Refusing to trash root path: ${targetPath}`);
  }
  const base = path.basename(resolvedTargetPath).replace(/[\\/]+/g, "");
  if (!base) {
    throw new Error(`Unable to derive safe trash basename for: ${targetPath}`);
  }
  return base;
}

function resolveContainedPath(root: string, leaf: string): string {
  const resolvedRoot = path.resolve(root);
  const resolvedPath = path.resolve(resolvedRoot, leaf);
  if (!isSameOrChildPath(resolvedPath, resolvedRoot) || resolvedPath === resolvedRoot) {
    throw new Error(`Trash destination escaped trash directory: ${resolvedPath}`);
  }
  return resolvedPath;
}

function reserveTrashDestination(trashDir: string, base: string, timestamp: number): string {
  const containerPrefix = resolveContainedPath(trashDir, `${base}-${timestamp}-`);
  const container = fs.mkdtempSync(containerPrefix);
  const resolvedContainer = path.resolve(container);
  const resolvedTrashDir = path.resolve(trashDir);
  if (
    resolvedContainer === resolvedTrashDir ||
    !isSameOrChildPath(resolvedContainer, resolvedTrashDir)
  ) {
    throw new Error(`Trash destination escaped trash directory: ${container}`);
  }
  return resolveContainedPath(container, base);
}

function movePathToDestination(targetPath: string, dest: string): boolean {
  try {
    fs.renameSync(targetPath, dest);
    return true;
  } catch (error) {
    if (getFsErrorCode(error) !== "EXDEV") {
      if (isTrashDestinationCollision(error)) {
        return false;
      }
      throw error;
    }
  }

  try {
    fs.cpSync(targetPath, dest, { recursive: true, force: false, errorOnExist: true });
    fs.rmSync(targetPath, { recursive: true, force: false });
    return true;
  } catch (error) {
    if (isTrashDestinationCollision(error)) {
      return false;
    }
    throw error;
  }
}

export async function movePathToTrash(targetPath: string): Promise<string> {
  // Avoid resolving external trash helpers through the service PATH during cleanup.
  const base = trashBaseName(targetPath);
  assertAllowedTrashTarget(targetPath);
  const trashDir = resolveTrashDir();
  const timestamp = Date.now();
  for (let attempt = 0; attempt < TRASH_DESTINATION_RETRY_LIMIT; attempt += 1) {
    const dest = reserveTrashDestination(trashDir, base, timestamp);
    if (movePathToDestination(targetPath, dest)) {
      return dest;
    }
  }

  throw new Error(`Unable to choose a unique trash destination for ${targetPath}`);
}
