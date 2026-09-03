/** Whole-tree manifests and immutable copy support for update generations. */
import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import fs, { type FileHandle } from "node:fs/promises";
import path from "node:path";
import { hasErrnoCode } from "./errors.js";
import type { UpdateGenerationManifest } from "./update-generation-contract.js";

type GenerationManifestEntry =
  | { path: string; type: "directory"; mode: number }
  | { path: string; type: "file"; mode: number; size: number; sha256: string }
  | { path: string; type: "symlink"; target: string };

export function updateGenerationPathIsEqualOrNested(
  parentPath: string,
  candidatePath: string,
): boolean {
  const relative = path.relative(parentPath, candidatePath);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
}

function sameEntryIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameEntryState(left: BigIntStats, right: BigIntStats): boolean {
  return (
    sameEntryIdentity(left, right) &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function requireStableEntry(params: {
  expected: BigIntStats;
  actual: BigIntStats;
  entryPath: string;
}): void {
  if (!sameEntryState(params.expected, params.actual)) {
    throw new Error(`Update generation source changed while reading: ${params.entryPath}`);
  }
}

async function readStableFile(params: {
  filePath: string;
  expected: BigIntStats;
  consume?: (chunk: Buffer) => Promise<void>;
}): Promise<{ mode: number; size: number; sha256: string }> {
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const handle = await fs.open(params.filePath, constants.O_RDONLY | noFollow);
  const hash = createHash("sha256");
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameEntryIdentity(params.expected, opened)) {
      throw new Error(`Update generation source file was replaced: ${params.filePath}`);
    }
    const buffer = Buffer.allocUnsafe(64 * 1024);
    let position = 0;
    while (true) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) {
        break;
      }
      const chunk = buffer.subarray(0, bytesRead);
      hash.update(chunk);
      await params.consume?.(chunk);
      position += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    requireStableEntry({ expected: opened, actual: after, entryPath: params.filePath });
    if (after.size > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error(`Update generation source file is too large: ${params.filePath}`);
    }
    return {
      mode: normalizedMode(Number(after.mode)),
      size: Number(after.size),
      sha256: hash.digest("hex"),
    };
  } finally {
    await handle.close();
  }
}

function normalizedMode(mode: number): number {
  return mode & 0o555;
}

export async function captureUpdateGenerationManifest(
  root: string,
): Promise<UpdateGenerationManifest> {
  const rootPath = path.resolve(root);
  const rootStat = await fs.lstat(rootPath, { bigint: true });
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error(`Update generation source is not a directory: ${rootPath}`);
  }
  const entries: GenerationManifestEntry[] = [];
  let totalBytes = 0;

  const walk = async (
    current: string,
    relativeDirectory: string,
    expectedDirectory: BigIntStats,
  ): Promise<void> => {
    const openedDirectory = await fs.lstat(current, { bigint: true });
    if (
      !openedDirectory.isDirectory() ||
      openedDirectory.isSymbolicLink() ||
      !sameEntryIdentity(expectedDirectory, openedDirectory)
    ) {
      throw new Error(`Update generation source directory was replaced: ${current}`);
    }
    const children = (await fs.readdir(current)).toSorted((left, right) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    for (const child of children) {
      const childPath = path.join(current, child);
      const relativePath = relativeDirectory ? `${relativeDirectory}/${child}` : child;
      const stat = await fs.lstat(childPath, { bigint: true });
      if (stat.isSymbolicLink()) {
        const target = await fs.readlink(childPath);
        const after = await fs.lstat(childPath, { bigint: true });
        requireStableEntry({ expected: stat, actual: after, entryPath: childPath });
        if (path.isAbsolute(target) || path.win32.isAbsolute(target)) {
          throw new Error(`Update generation contains an absolute symlink: ${relativePath}`);
        }
        const resolvedTarget = path.resolve(path.dirname(childPath), target);
        if (!updateGenerationPathIsEqualOrNested(rootPath, resolvedTarget)) {
          throw new Error(`Update generation symlink escapes its source: ${relativePath}`);
        }
        entries.push({ path: relativePath, type: "symlink", target });
        continue;
      }
      if (stat.isDirectory()) {
        entries.push({
          path: relativePath,
          type: "directory",
          mode: normalizedMode(Number(stat.mode)),
        });
        await walk(childPath, relativePath, stat);
        continue;
      }
      if (!stat.isFile()) {
        throw new Error(`Update generation contains an unsupported entry: ${relativePath}`);
      }
      const file = await readStableFile({ filePath: childPath, expected: stat });
      totalBytes += file.size;
      entries.push({
        path: relativePath,
        type: "file",
        mode: file.mode,
        size: file.size,
        sha256: file.sha256,
      });
    }
    const afterDirectory = await fs.lstat(current, { bigint: true });
    requireStableEntry({
      expected: openedDirectory,
      actual: afterDirectory,
      entryPath: current,
    });
  };
  await walk(rootPath, "", rootStat);
  const digest = createHash("sha256")
    .update(entries.map((entry) => JSON.stringify(entry)).join("\n"))
    .digest("hex");
  return {
    algorithm: "sha256",
    digest,
    entryCount: entries.length,
    totalBytes,
  };
}

async function writeAll(handle: FileHandle, chunk: Buffer): Promise<void> {
  let offset = 0;
  while (offset < chunk.length) {
    const { bytesWritten } = await handle.write(chunk, offset, chunk.length - offset);
    if (bytesWritten === 0) {
      throw new Error("Unable to copy update generation source bytes");
    }
    offset += bytesWritten;
  }
}

export async function copyUpdateGenerationTree(sourceRoot: string, destinationRoot: string) {
  const source = path.resolve(sourceRoot);
  const sourceStat = await fs.lstat(source, { bigint: true });
  if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink()) {
    throw new Error(`Update generation source is not a directory: ${source}`);
  }
  await fs.mkdir(destinationRoot, { mode: 0o700 });

  const copyDirectory = async (
    currentSource: string,
    currentDestination: string,
    expectedDirectory: BigIntStats,
  ): Promise<void> => {
    const openedDirectory = await fs.lstat(currentSource, { bigint: true });
    if (
      !openedDirectory.isDirectory() ||
      openedDirectory.isSymbolicLink() ||
      !sameEntryIdentity(expectedDirectory, openedDirectory)
    ) {
      throw new Error(`Update generation source directory was replaced: ${currentSource}`);
    }
    const children = (await fs.readdir(currentSource)).toSorted((left, right) =>
      left < right ? -1 : left > right ? 1 : 0,
    );
    for (const child of children) {
      const sourcePath = path.join(currentSource, child);
      const destinationPath = path.join(currentDestination, child);
      const stat = await fs.lstat(sourcePath, { bigint: true });
      if (stat.isSymbolicLink()) {
        const target = await fs.readlink(sourcePath);
        const resolvedTarget = path.resolve(path.dirname(sourcePath), target);
        if (
          path.isAbsolute(target) ||
          path.win32.isAbsolute(target) ||
          !updateGenerationPathIsEqualOrNested(source, resolvedTarget)
        ) {
          throw new Error(`Update generation symlink escapes its source: ${sourcePath}`);
        }
        const after = await fs.lstat(sourcePath, { bigint: true });
        requireStableEntry({ expected: stat, actual: after, entryPath: sourcePath });
        await fs.symlink(target, destinationPath);
        continue;
      }
      if (stat.isDirectory()) {
        await fs.mkdir(destinationPath, { mode: 0o700 });
        await copyDirectory(sourcePath, destinationPath, stat);
        await fs.chmod(destinationPath, normalizedMode(Number(stat.mode)));
        continue;
      }
      if (!stat.isFile()) {
        throw new Error(`Update generation contains an unsupported entry: ${sourcePath}`);
      }
      const destination = await fs.open(destinationPath, "wx", 0o600);
      try {
        const copied = await readStableFile({
          filePath: sourcePath,
          expected: stat,
          consume: async (chunk) => await writeAll(destination, chunk),
        });
        await destination.chmod(copied.mode);
        await destination.sync();
      } finally {
        await destination.close();
      }
    }
    const afterDirectory = await fs.lstat(currentSource, { bigint: true });
    requireStableEntry({
      expected: openedDirectory,
      actual: afterDirectory,
      entryPath: currentSource,
    });
  };

  await copyDirectory(source, destinationRoot, sourceStat);
  await fs.chmod(destinationRoot, normalizedMode(Number(sourceStat.mode)));
}

export async function sealUpdateGenerationTree(root: string): Promise<void> {
  const directories: Array<{ path: string; mode: number }> = [];
  const walk = async (current: string): Promise<void> => {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      const stat = await fs.lstat(entryPath);
      if (stat.isSymbolicLink()) {
        continue;
      }
      if (stat.isDirectory()) {
        directories.push({ path: entryPath, mode: normalizedMode(stat.mode) });
        await walk(entryPath);
      } else if (stat.isFile()) {
        await fs.chmod(entryPath, normalizedMode(stat.mode));
      }
    }
  };
  const rootStat = await fs.lstat(root);
  directories.push({ path: root, mode: normalizedMode(rootStat.mode) });
  await walk(root);
  for (const directory of directories.toReversed()) {
    await fs.chmod(directory.path, directory.mode);
  }
}

export async function syncUpdateGenerationPath(filePath: string): Promise<void> {
  try {
    const handle = await fs.open(filePath, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (
      !hasErrnoCode(error, "EISDIR") &&
      !hasErrnoCode(error, "EINVAL") &&
      !hasErrnoCode(error, "EPERM") &&
      !hasErrnoCode(error, "EACCES")
    ) {
      throw error;
    }
  }
}

export async function syncUpdateGenerationTree(root: string): Promise<void> {
  const walk = async (current: string): Promise<void> => {
    const entries = await fs.readdir(current, { withFileTypes: true });
    for (const entry of entries) {
      const entryPath = path.join(current, entry.name);
      if (entry.isSymbolicLink()) {
        continue;
      }
      if (entry.isDirectory()) {
        await walk(entryPath);
      } else if (entry.isFile()) {
        await syncUpdateGenerationPath(entryPath);
      }
    }
    await syncUpdateGenerationPath(current);
  };
  await walk(root);
}

async function makeUpdateGenerationTreeWritable(root: string): Promise<void> {
  const stat = await fs.lstat(root).catch(() => null);
  if (!stat || stat.isSymbolicLink()) {
    return;
  }
  if (stat.isDirectory()) {
    await fs.chmod(root, stat.mode | 0o700).catch(() => undefined);
    for (const entry of await fs.readdir(root)) {
      await makeUpdateGenerationTreeWritable(path.join(root, entry));
    }
  } else {
    await fs.chmod(root, stat.mode | 0o600).catch(() => undefined);
  }
}

export async function removeUpdateGenerationTree(root: string): Promise<void> {
  await makeUpdateGenerationTreeWritable(root);
  await fs.rm(root, { recursive: true, force: true });
}
