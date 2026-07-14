// Safe recursive removal helpers for focused plugin file-access surfaces.
import "./fs-safe-defaults.js";
import path from "node:path";
import { FsSafeError } from "@openclaw/fs-safe/errors";
import { root as fsSafeRoot, type Root } from "@openclaw/fs-safe/root";

async function listDirectoryEntries(root: Root, relativePath: string) {
  return await root.list(relativePath, { withFileTypes: true });
}

type DirectoryEntry = Awaited<ReturnType<typeof listDirectoryEntries>>[number];

function compareDirectoryEntryNames(left: DirectoryEntry, right: DirectoryEntry): number {
  if (left.name === right.name) {
    return 0;
  }
  return left.name < right.name ? -1 : 1;
}

function isNotFoundError(error: unknown): error is NodeJS.ErrnoException {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === "not-found" || code === "ENOENT";
}

function relativeParentPath(relativePath: string): string {
  const parentPath = path.dirname(relativePath);
  return parentPath === "." ? "" : parentPath;
}

function joinRootRelativePath(parentRelativePath: string, childName: string): string {
  return parentRelativePath.length === 0 ? childName : path.join(parentRelativePath, childName);
}

async function findDirectoryEntry(
  root: Root,
  relativePath: string,
): Promise<DirectoryEntry | undefined> {
  const targetName = path.basename(relativePath);
  if (targetName.length === 0 || targetName === ".") {
    return undefined;
  }
  const entries = await listDirectoryEntries(root, relativeParentPath(relativePath));
  return entries.find((entry) => entry.name === targetName);
}

async function removeRootRelativePath(
  root: Root,
  relativePath: string,
  suppressNotFound: boolean,
): Promise<void> {
  try {
    await root.remove(relativePath);
  } catch (error) {
    if (isNotFoundError(error)) {
      if (suppressNotFound) {
        return;
      }
      throw new FsSafeError("not-found", "file not found", {
        cause: error instanceof Error ? error : undefined,
      });
    }
    throw error;
  }
}

function assertNotSymbolicLink(relativePath: string, entry: DirectoryEntry): void {
  if (!entry.isSymbolicLink) {
    return;
  }
  throw new FsSafeError("symlink", `symlink not allowed: ${relativePath}`);
}

async function removeDirectoryEntry(
  root: Root,
  relativePath: string,
  suppressNotFound: boolean,
): Promise<void> {
  const entry = await findDirectoryEntry(root, relativePath).catch((error: unknown) => {
    if (suppressNotFound && isNotFoundError(error)) {
      return undefined;
    }
    throw error;
  });
  if (!entry) {
    await removeRootRelativePath(root, relativePath, suppressNotFound);
    return;
  }
  assertNotSymbolicLink(relativePath, entry);
  if (entry.isDirectory) {
    const children = (
      await listDirectoryEntries(root, relativePath).catch((error: unknown) => {
        if (suppressNotFound && isNotFoundError(error)) {
          return undefined;
        }
        throw error;
      })
    )?.toSorted(compareDirectoryEntryNames);
    if (!children) {
      await removeRootRelativePath(root, relativePath, suppressNotFound);
      return;
    }
    for (const child of children) {
      await removeDirectoryEntry(
        root,
        joinRootRelativePath(relativePath, child.name),
        suppressNotFound,
      );
    }
  }
  await removeRootRelativePath(root, relativePath, suppressNotFound);
}

export async function removePathWithinRoot(params: {
  rootDir: string;
  relativePath: string;
  recursive?: boolean;
  force?: boolean;
}): Promise<void> {
  const root = await fsSafeRoot(params.rootDir);
  const suppressNotFound = params.force !== false;
  const recursive = params.recursive === true;
  const entry = await findDirectoryEntry(root, params.relativePath).catch((error: unknown) => {
    if (suppressNotFound && isNotFoundError(error)) {
      return undefined;
    }
    throw error;
  });
  if (!entry) {
    await removeRootRelativePath(root, params.relativePath, suppressNotFound);
    return;
  }
  if (!recursive || !entry.isDirectory) {
    assertNotSymbolicLink(params.relativePath, entry);
    await removeRootRelativePath(root, params.relativePath, suppressNotFound);
    return;
  }
  await removeDirectoryEntry(root, params.relativePath, suppressNotFound);
}
