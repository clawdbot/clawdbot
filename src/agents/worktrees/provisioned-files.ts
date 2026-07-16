import { constants as fsConstants } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { pathExists, requireGitRaw } from "./git.js";
import {
  clearRegistryWorktreeProvisionedChunks,
  getRegistryWorktreeProvisionedChunk,
  insertRegistryWorktreeProvisionedChunk,
} from "./registry.js";
import type { ProvisionedFileState } from "./types.js";

function normalizeRelativePath(relativePath: string): string | undefined {
  if (path.isAbsolute(relativePath)) {
    return undefined;
  }
  const segments = relativePath.split("/");
  if (
    segments.length === 0 ||
    segments.some((segment) => !segment || segment === "." || segment === "..")
  ) {
    return undefined;
  }
  return segments.join("/");
}

function resolveGitPath(root: string, relativePath: string): string {
  return path.join(root, ...relativePath.split("/"));
}

async function hasSafeParentDirectories(root: string, relativePath: string): Promise<boolean> {
  const segments = relativePath.split("/");
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment);
    try {
      const stat = await fs.lstat(current);
      if (stat.isSymbolicLink() || !stat.isDirectory()) {
        return false;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }
    }
  }
  return true;
}

async function lstatIfExists(target: string) {
  try {
    return await fs.lstat(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
}

async function copyProvisionedFile(params: {
  repoRoot: string;
  worktreePath: string;
  relativePath: string;
}): Promise<boolean> {
  const normalized = normalizeRelativePath(params.relativePath);
  if (
    !normalized ||
    !(await hasSafeParentDirectories(params.repoRoot, normalized)) ||
    !(await hasSafeParentDirectories(params.worktreePath, normalized))
  ) {
    return false;
  }
  const source = resolveGitPath(params.repoRoot, normalized);
  const destination = resolveGitPath(params.worktreePath, normalized);
  const sourceStat = await fs.lstat(source).catch(() => undefined);
  if (!sourceStat?.isFile() || sourceStat.isSymbolicLink()) {
    return false;
  }
  await fs.mkdir(path.dirname(destination), { recursive: true });
  try {
    await fs.copyFile(source, destination, fsConstants.COPYFILE_EXCL);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      // Existing checkout state is user-owned. Never mutate or claim it as provisioned.
      return false;
    }
    throw error;
  }
  await fs.chmod(destination, sourceStat.mode);
  return true;
}

/** Copies the current manifest matches and returns only paths this call actually created. */
export async function provisionIncludedFiles(
  repoRoot: string,
  worktreePath: string,
): Promise<string[]> {
  const includePath = path.join(repoRoot, ".worktreeinclude");
  if (!(await pathExists(includePath))) {
    return [];
  }
  const candidatesRaw = await requireGitRaw(repoRoot, [
    "ls-files",
    "--others",
    "--ignored",
    "--exclude-standard",
    "-z",
  ]);
  const includedRaw = await requireGitRaw(repoRoot, [
    "ls-files",
    "--others",
    "--ignored",
    `--exclude-from=${includePath}`,
    "-z",
  ]);
  const included = new Set(includedRaw.split("\0").filter(Boolean));
  const provisioned: string[] = [];
  for (const relativePath of candidatesRaw.split("\0").filter(Boolean)) {
    if (!included.has(relativePath)) {
      continue;
    }
    const normalized = normalizeRelativePath(relativePath);
    if (
      normalized &&
      (await copyProvisionedFile({ repoRoot, worktreePath, relativePath: normalized }))
    ) {
      provisioned.push(normalized);
    }
  }
  return provisioned.toSorted();
}

type ProvisionedFile = {
  path: string;
  target: string;
  mode: number | null;
};

type DirectoryIdentity = {
  path: string;
  dev: number;
  ino: number;
};

const SNAPSHOT_CHUNK_BYTES = 1024 * 1024;

async function captureParentDirectoryIdentities(
  root: string,
  relativePath: string,
): Promise<DirectoryIdentity[]> {
  const segments = relativePath.split("/");
  const directories = [root];
  let current = root;
  for (const segment of segments.slice(0, -1)) {
    current = path.join(current, segment);
    directories.push(current);
  }
  const identities: DirectoryIdentity[] = [];
  for (const directory of directories) {
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error(`unsafe provisioned parent directory: ${directory}`);
    }
    identities.push({ path: directory, dev: stat.dev, ino: stat.ino });
  }
  return identities;
}

async function validateDirectoryIdentities(identities: readonly DirectoryIdentity[]) {
  for (const identity of identities) {
    const stat = await fs.lstat(identity.path);
    if (
      !stat.isDirectory() ||
      stat.isSymbolicLink() ||
      stat.dev !== identity.dev ||
      stat.ino !== identity.ino
    ) {
      throw new Error(`provisioned parent directory changed: ${identity.path}`);
    }
  }
}

async function inspectProvisionedFiles(
  worktreePath: string,
  provisionedPaths: readonly string[] | undefined,
): Promise<ProvisionedFile[] | undefined> {
  if (provisionedPaths === undefined) {
    return undefined;
  }
  const files: ProvisionedFile[] = [];
  for (const relativePath of provisionedPaths) {
    const normalized = normalizeRelativePath(relativePath);
    if (!normalized || !(await hasSafeParentDirectories(worktreePath, normalized))) {
      throw new Error(`unsafe provisioned path: ${relativePath}`);
    }
    const target = resolveGitPath(worktreePath, normalized);
    const stat = await lstatIfExists(target);
    if (!stat) {
      files.push({ path: normalized, target, mode: null });
      continue;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw new Error(`provisioned path is no longer a regular file: ${relativePath}`);
    }
    files.push({ path: normalized, target, mode: stat.mode & 0o7777 });
  }
  return files.toSorted((a, b) => a.path.localeCompare(b.path));
}

export async function hasUnsnapshotableProvisionedFiles(
  worktreePath: string,
  provisionedPaths: readonly string[] | undefined,
): Promise<boolean> {
  try {
    return (await inspectProvisionedFiles(worktreePath, provisionedPaths)) === undefined;
  } catch {
    return true;
  }
}

function sameFileState(left: Awaited<ReturnType<FileHandle["stat"]>>, right: typeof left) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

/** Stores provisioned bytes outside Git so ignored credentials never enter its object database. */
export async function snapshotProvisionedFiles(
  env: NodeJS.ProcessEnv,
  worktreeId: string,
  worktreePath: string,
  provisionedPaths: readonly string[] | undefined,
): Promise<ProvisionedFileState[]> {
  const files = await inspectProvisionedFiles(worktreePath, provisionedPaths);
  if (files === undefined) {
    throw new Error("provisioned path ledger is unavailable");
  }
  const ignoredUntracked = new Set(
    (
      await requireGitRaw(worktreePath, [
        "ls-files",
        "--others",
        "--ignored",
        "--exclude-standard",
        "-z",
      ])
    )
      .split("\0")
      .filter(Boolean),
  );
  const currentTracked = new Set(
    (await requireGitRaw(worktreePath, ["ls-files", "--cached", "-z"])).split("\0").filter(Boolean),
  );
  const trackedAtHead = new Set(
    (await requireGitRaw(worktreePath, ["ls-tree", "-r", "--name-only", "-z", "HEAD"]))
      .split("\0")
      .filter(Boolean),
  );
  clearRegistryWorktreeProvisionedChunks(env, worktreeId);
  const states: ProvisionedFileState[] = [];
  try {
    for (const file of files) {
      if (file.mode === null) {
        states.push({ path: file.path, mode: null, chunks: 0 });
        continue;
      }
      if (currentTracked.has(file.path)) {
        throw new Error(`provisioned path is now tracked: ${file.path}`);
      }
      if (trackedAtHead.has(file.path)) {
        throw new Error(`provisioned path is tracked at HEAD: ${file.path}`);
      }
      if (!ignoredUntracked.has(file.path)) {
        throw new Error(`provisioned path is no longer ignored: ${file.path}`);
      }
      const parentIdentities = await captureParentDirectoryIdentities(worktreePath, file.path);
      const handle = await fs.open(
        file.target,
        fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0),
      );
      try {
        await validateDirectoryIdentities(parentIdentities);
        const before = await handle.stat();
        const buffer = Buffer.allocUnsafe(SNAPSHOT_CHUNK_BYTES);
        let chunkIndex = 0;
        let offset = 0;
        while (offset < before.size) {
          const { bytesRead } = await handle.read(
            buffer,
            0,
            Math.min(buffer.byteLength, before.size - offset),
            offset,
          );
          if (bytesRead === 0) {
            throw new Error(`provisioned file changed while snapshotting: ${file.path}`);
          }
          insertRegistryWorktreeProvisionedChunk(env, {
            worktreeId,
            path: file.path,
            chunkIndex,
            data: buffer.subarray(0, bytesRead),
          });
          offset += bytesRead;
          chunkIndex += 1;
        }
        const [after, current] = await Promise.all([handle.stat(), fs.lstat(file.target)]);
        await validateDirectoryIdentities(parentIdentities);
        if (!sameFileState(before, after) || !sameFileState(before, current)) {
          throw new Error(`provisioned file changed while snapshotting: ${file.path}`);
        }
        states.push({ path: file.path, mode: before.mode & 0o7777, chunks: chunkIndex });
      } finally {
        await handle.close();
      }
    }
    return states;
  } catch (error) {
    clearRegistryWorktreeProvisionedChunks(env, worktreeId);
    throw error;
  }
}

async function writeAll(handle: FileHandle, data: Uint8Array): Promise<void> {
  let offset = 0;
  while (offset < data.byteLength) {
    const { bytesWritten } = await handle.write(data, offset, data.byteLength - offset);
    if (bytesWritten === 0) {
      throw new Error("provisioned snapshot write made no progress");
    }
    offset += bytesWritten;
  }
}

/** Restores provisioned bytes and modes from SQLite, never from the mutable source checkout. */
export async function restoreProvisionedFiles(
  env: NodeJS.ProcessEnv,
  worktreeId: string,
  worktreePath: string,
  states: readonly ProvisionedFileState[],
): Promise<void> {
  for (const state of states) {
    const normalized = normalizeRelativePath(state.path);
    if (!normalized || !(await hasSafeParentDirectories(worktreePath, normalized))) {
      throw new Error(`unsafe provisioned path: ${state.path}`);
    }
    const target = resolveGitPath(worktreePath, normalized);
    if (state.mode === null) {
      if (await lstatIfExists(target)) {
        throw new Error(`snapshot expected provisioned path to be absent: ${state.path}`);
      }
      continue;
    }
    await fs.mkdir(path.dirname(target), { recursive: true });
    const parentIdentities = await captureParentDirectoryIdentities(worktreePath, normalized);
    const handle = await fs.open(
      target,
      fsConstants.O_CREAT |
        fsConstants.O_EXCL |
        fsConstants.O_WRONLY |
        (fsConstants.O_NOFOLLOW ?? 0),
      state.mode,
    );
    try {
      await validateDirectoryIdentities(parentIdentities);
      for (let chunkIndex = 0; chunkIndex < state.chunks; chunkIndex += 1) {
        const chunk = getRegistryWorktreeProvisionedChunk(env, {
          worktreeId,
          path: state.path,
          chunkIndex,
        });
        if (!chunk) {
          throw new Error(`provisioned snapshot chunk missing: ${state.path}:${chunkIndex}`);
        }
        await writeAll(handle, chunk);
      }
      await handle.chmod(state.mode);
      await validateDirectoryIdentities(parentIdentities);
    } finally {
      await handle.close();
    }
  }
}
