import { createHash } from "node:crypto";
import { constants as fsConstants, lstatSync, readdirSync } from "node:fs";
import fs from "node:fs/promises";
import { endianness } from "node:os";
import path from "node:path";
import { text } from "node:stream/consumers";
import { formatErrorMessage } from "./errors.js";

const SQLITE_FILE_HEADER = Buffer.from("SQLite format 3\0", "utf8");
const SQLITE_SHM_REGION_BYTES = 32_768;
const SQLITE_WAL_INDEX_HEADER_COPY_BYTES = 48;
const SQLITE_WAL_INDEX_HEADER_BYTES = SQLITE_WAL_INDEX_HEADER_COPY_BYTES * 2;
const SQLITE_WAL_INDEX_VERSION = 3_007_000;
const SQLITE_WAL_HEADER_BYTES = 32;
const SQLITE_WAL_MAGIC_LE = 0x377f_0682;
const SQLITE_WAL_MAGIC_BE = 0x377f_0683;
const SQLITE_SHM_VOLATILE_RANGES = [
  [96, 120],
  [128, 132],
] as const;
const SNAPSHOT_HASH_BUFFER_BYTES = 1024 * 1024;

type SqliteChecksumByteOrder = "BE" | "LE";
type SnapshotEntry = {
  path: string;
  stat: Awaited<ReturnType<typeof fs.lstat>>;
  children?: string[];
};
export type ConfigInputHashes = {
  root: string;
  includes: readonly { path: string; hash: string }[];
};

function readUint32(buffer: Buffer, offset: number, byteOrder: SqliteChecksumByteOrder): number {
  return byteOrder === "LE" ? buffer.readUInt32LE(offset) : buffer.readUInt32BE(offset);
}

function sqliteWalChecksum(
  buffer: Buffer,
  byteOrder: SqliteChecksumByteOrder,
): readonly [number, number] {
  let first = 0;
  let second = 0;
  for (let offset = 0; offset < buffer.length; offset += 8) {
    first = (first + readUint32(buffer, offset, byteOrder) + second) >>> 0;
    second = (second + readUint32(buffer, offset + 4, byteOrder) + first) >>> 0;
  }
  return [first, second];
}

async function digestFile(
  filePath: string,
  observedEntries: SnapshotEntry[],
  hashPrefix = "",
): Promise<string> {
  const before = await fs.lstat(filePath);
  if (!before.isFile()) {
    throw new Error(`Snapshot path is not a regular file: ${filePath}`);
  }
  if (before.nlink !== 1) {
    throw new Error(`Snapshot path has unbound hard links: ${filePath}`);
  }
  observedEntries.push({ path: filePath, stat: before });
  const handle = await openSnapshotRegularFile(filePath);
  if (!handle) {
    throw new Error(`Snapshot path is not a regular file: ${filePath}`);
  }
  const fileDigest = await digestSnapshotFileHandle(filePath, handle, before, [], hashPrefix);
  return `sha256:${fileDigest}`;
}

async function openSnapshotRegularFile(filePath: string): Promise<fs.FileHandle | undefined> {
  let before: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    before = await fs.lstat(filePath);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  if (!before.isFile()) {
    return undefined;
  }
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(
      filePath,
      fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0) | (fsConstants.O_NONBLOCK ?? 0),
    );
    const [opened, after] = await Promise.all([handle.stat(), fs.lstat(filePath)]);
    if (
      !opened.isFile() ||
      !after.isFile() ||
      before.dev !== opened.dev ||
      before.ino !== opened.ino ||
      before.dev !== after.dev ||
      before.ino !== after.ino
    ) {
      throw new Error(`Snapshot file changed while opening: ${filePath}`);
    }
    return handle;
  } catch (error) {
    await handle?.close();
    throw error;
  }
}

async function openSqliteSharedMemoryEntry(
  directory: string,
  entry: string,
): Promise<fs.FileHandle | undefined> {
  if (!entry.endsWith("-shm")) {
    return undefined;
  }
  const databasePath = path.join(directory, entry.slice(0, -"-shm".length));
  const sharedMemoryPath = path.join(directory, entry);
  let databaseHandle: fs.FileHandle | undefined;
  try {
    databaseHandle = await openSnapshotRegularFile(databasePath);
    if (!databaseHandle) {
      return undefined;
    }
    const header = Buffer.alloc(SQLITE_FILE_HEADER.length);
    const { bytesRead } = await databaseHandle.read(header, 0, header.length, 0);
    if (bytesRead !== header.length || !header.equals(SQLITE_FILE_HEADER)) {
      return undefined;
    }
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  } finally {
    await databaseHandle?.close();
  }

  let sharedMemoryStat: Awaited<ReturnType<typeof fs.lstat>>;
  try {
    sharedMemoryStat = await fs.lstat(sharedMemoryPath);
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  }
  if (
    !sharedMemoryStat.isFile() ||
    sharedMemoryStat.size === 0 ||
    sharedMemoryStat.size % SQLITE_SHM_REGION_BYTES !== 0
  ) {
    return undefined;
  }

  let sharedMemoryHandle: fs.FileHandle | undefined;
  let walHandle: fs.FileHandle | undefined;
  try {
    sharedMemoryHandle = await openSnapshotRegularFile(sharedMemoryPath);
    if (!sharedMemoryHandle) {
      return undefined;
    }
    const header = Buffer.alloc(SQLITE_WAL_INDEX_HEADER_BYTES);
    const { bytesRead } = await sharedMemoryHandle.read(header, 0, header.length, 0);
    if (bytesRead !== header.length) {
      return undefined;
    }
    const first = header.subarray(0, SQLITE_WAL_INDEX_HEADER_COPY_BYTES);
    const second = header.subarray(SQLITE_WAL_INDEX_HEADER_COPY_BYTES);
    const nativeByteOrder = endianness();
    const [indexChecksumFirst, indexChecksumSecond] = sqliteWalChecksum(
      first.subarray(0, 40),
      nativeByteOrder,
    );
    if (
      readUint32(first, 0, nativeByteOrder) !== SQLITE_WAL_INDEX_VERSION ||
      readUint32(first, 4, nativeByteOrder) !== 0 ||
      first[12] !== 1 ||
      readUint32(first, 40, nativeByteOrder) !== indexChecksumFirst ||
      readUint32(first, 44, nativeByteOrder) !== indexChecksumSecond ||
      !first.equals(second)
    ) {
      return undefined;
    }

    walHandle = await openSnapshotRegularFile(`${databasePath}-wal`);
    if (!walHandle) {
      return undefined;
    }
    const walHeader = Buffer.alloc(SQLITE_WAL_HEADER_BYTES);
    const walRead = await walHandle.read(walHeader, 0, walHeader.length, 0);
    if (walRead.bytesRead !== walHeader.length) {
      return undefined;
    }
    const walMagic = walHeader.readUInt32BE(0);
    const walByteOrder: SqliteChecksumByteOrder = walMagic === SQLITE_WAL_MAGIC_LE ? "LE" : "BE";
    if (
      (walMagic !== SQLITE_WAL_MAGIC_LE && walMagic !== SQLITE_WAL_MAGIC_BE) ||
      walHeader.readUInt32BE(4) !== SQLITE_WAL_INDEX_VERSION
    ) {
      return undefined;
    }
    const [walChecksumFirst, walChecksumSecond] = sqliteWalChecksum(
      walHeader.subarray(0, 24),
      walByteOrder,
    );
    if (
      walHeader.readUInt32BE(24) === walChecksumFirst &&
      walHeader.readUInt32BE(28) === walChecksumSecond &&
      first.subarray(32, 40).equals(walHeader.subarray(16, 24))
    ) {
      const verifiedHandle = sharedMemoryHandle;
      sharedMemoryHandle = undefined;
      return verifiedHandle;
    }
    return undefined;
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
      return undefined;
    }
    throw error;
  } finally {
    await sharedMemoryHandle?.close();
    await walHandle?.close();
  }
}

async function digestSnapshotFileHandle(
  filePath: string,
  handle: fs.FileHandle,
  expectedStat: Awaited<ReturnType<typeof fs.lstat>>,
  volatileRanges: readonly (readonly [number, number])[] = [],
  hashPrefix = "",
): Promise<string> {
  const hash = createHash("sha256").update(hashPrefix);
  const buffer = Buffer.alloc(SNAPSHOT_HASH_BUFFER_BYTES);
  let position = 0;
  try {
    const opened = await handle.stat();
    if (
      expectedStat.dev !== opened.dev ||
      expectedStat.ino !== opened.ino ||
      expectedStat.size !== opened.size ||
      expectedStat.mtimeMs !== opened.mtimeMs
    ) {
      throw new Error(`Snapshot file changed before hashing: ${filePath}`);
    }
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, position);
      if (bytesRead === 0) {
        break;
      }
      const chunk = Buffer.from(buffer.subarray(0, bytesRead));
      for (const [rangeStart, rangeEnd] of volatileRanges) {
        const overlapStart = Math.max(position, rangeStart);
        const overlapEnd = Math.min(position + bytesRead, rangeEnd);
        if (overlapStart < overlapEnd) {
          chunk.fill(0, overlapStart - position, overlapEnd - position);
        }
      }
      hash.update(chunk);
      position += bytesRead;
    }
    const after = await handle.stat();
    if (
      expectedStat.dev !== after.dev ||
      expectedStat.ino !== after.ino ||
      expectedStat.size !== after.size ||
      expectedStat.mtimeMs !== after.mtimeMs
    ) {
      throw new Error(`Snapshot file changed while hashing: ${filePath}`);
    }
  } finally {
    await handle.close();
  }
  return hash.digest("hex");
}

async function digestDirectory(
  directory: string,
  observedEntries: SnapshotEntry[],
): Promise<string> {
  const rootStat = await fs.lstat(directory);
  if (!rootStat.isDirectory()) {
    throw new Error(`Snapshot state path is not a directory: ${directory}`);
  }
  const hash = createHash("sha256");
  const hardLinks = new Map<
    string,
    { firstPath: string; firstRelative: string; observed: number; expected: number }
  >();
  const visit = async (current: string, relative: string): Promise<void> => {
    const stat = await fs.lstat(current);
    // A symlink can escape the copied tree after identity capture. Plans bind only
    // regular entries owned by the supplied snapshot.
    if (stat.isSymbolicLink()) {
      throw new Error(`Snapshot tree contains a symbolic link: ${current}`);
    }
    const portableRelative = relative.split(path.sep).join("/");
    if (stat.isFile()) {
      observedEntries.push({ path: current, stat });
      const hardLinkKey = `${stat.dev}:${stat.ino}`;
      const existingHardLink = hardLinks.get(hardLinkKey);
      if (existingHardLink) {
        if (existingHardLink.expected !== stat.nlink) {
          throw new Error(`Snapshot hard-link count changed while hashing: ${current}`);
        }
        existingHardLink.observed += 1;
        hash
          .update("hardlink\0")
          .update(portableRelative)
          .update("\0")
          .update(existingHardLink.firstRelative)
          .update("\0");
        return;
      }
      hardLinks.set(hardLinkKey, {
        firstPath: current,
        firstRelative: portableRelative,
        observed: 1,
        expected: stat.nlink,
      });
      // Read-only SQLite opens can rebuild the wal-index header and checkpoint
      // counters. Authenticate it against its database/WAL before normalizing
      // those coordination fields; every other byte remains bound.
      const sharedMemoryHandle = await openSqliteSharedMemoryEntry(
        path.dirname(current),
        path.basename(current),
      );
      const handle = sharedMemoryHandle ?? (await openSnapshotRegularFile(current));
      if (!handle) {
        throw new Error(`Snapshot file changed before hashing: ${current}`);
      }
      const fileDigest = await digestSnapshotFileHandle(
        current,
        handle,
        stat,
        sharedMemoryHandle ? SQLITE_SHM_VOLATILE_RANGES : [],
      );
      hash.update("file\0").update(portableRelative).update("\0").update(fileDigest).update("\0");
      return;
    }
    if (!stat.isDirectory()) {
      throw new Error(`Snapshot tree contains a non-file entry: ${current}`);
    }
    hash.update("directory\0").update(portableRelative).update("\0");
    const entries = (await fs.readdir(current)).toSorted();
    observedEntries.push({ path: current, stat, children: entries });
    for (const entry of entries) {
      await visit(path.join(current, entry), path.join(relative, entry));
    }
  };
  await visit(directory, "");
  for (const hardLink of hardLinks.values()) {
    if (hardLink.observed !== hardLink.expected) {
      throw new Error(`Snapshot file has links outside copied state: ${hardLink.firstPath}`);
    }
  }
  return `sha256:${hash.digest("hex")}`;
}

function verifySnapshotEntries(observedEntries: readonly SnapshotEntry[]): void {
  // Earlier entries can change while later files are hashed. Validate the whole
  // observed set without yielding before returning its identity, not per subtree.
  for (const entry of observedEntries) {
    const after = lstatSync(entry.path);
    const before = entry.stat;
    if (
      before.isFile() !== after.isFile() ||
      before.isDirectory() !== after.isDirectory() ||
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.nlink !== after.nlink ||
      before.size !== after.size ||
      before.mtimeMs !== after.mtimeMs ||
      before.ctimeMs !== after.ctimeMs
    ) {
      throw new Error(`Snapshot entry changed while hashing: ${entry.path}`);
    }
    if (entry.children) {
      const children = readdirSync(entry.path).toSorted();
      if (
        entry.children.length !== children.length ||
        entry.children.some((child, index) => child !== children[index])
      ) {
        throw new Error(`Snapshot directory changed while hashing: ${entry.path}`);
      }
    }
  }
}

export type LegacyStateSnapshotInput = {
  configPath: string;
  stateDir: string;
  configInputHashes?: ConfigInputHashes;
};
export type LegacyStateSnapshotIdentity = {
  configDigest?: string;
  stateDigest?: string;
  warnings: string[];
};

// Raw source descriptors must close only in the snapshot child. A close in the
// caller process would release its SQLite POSIX locks on the same inode.
export async function captureLegacyStateSnapshotIdentityInProcess(
  params: LegacyStateSnapshotInput,
): Promise<LegacyStateSnapshotIdentity> {
  const warnings: string[] = [];
  const observedEntries: SnapshotEntry[] = [];
  const capture = async (label: string, pathname: string, read: () => Promise<string>) => {
    try {
      return await read();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`Could not bind copied ${label} at ${pathname}: ${message}`);
      return undefined;
    }
  };
  const configPath = path.resolve(params.configPath);
  const stateDir = path.resolve(params.stateDir);
  let configDigest = await capture("config", configPath, async () => {
    const rootDigest = await digestFile(configPath, observedEntries);
    if (params.configInputHashes) {
      if (rootDigest !== `sha256:${params.configInputHashes.root}`) {
        throw new Error(`Snapshot config changed while planning: ${configPath}`);
      }
      for (const input of params.configInputHashes.includes) {
        // The config owner hashes present includes with this domain prefix.
        const actual = await digestFile(input.path, observedEntries, "present\0");
        if (actual !== `sha256:${input.hash}`) {
          throw new Error(`Snapshot config input changed while planning: ${input.path}`);
        }
      }
    }
    return rootDigest;
  });
  let stateDigest = await capture("state", stateDir, () =>
    digestDirectory(stateDir, observedEntries),
  );
  if (warnings.length === 0) {
    try {
      verifySnapshotEntries(observedEntries);
    } catch (error) {
      warnings.push(`Could not bind copied snapshot: ${formatErrorMessage(error)}`);
      configDigest = undefined;
      stateDigest = undefined;
    }
  }
  return {
    ...(configDigest ? { configDigest } : {}),
    ...(stateDigest ? { stateDigest } : {}),
    warnings,
  };
}

async function runSnapshotWorker(): Promise<void> {
  try {
    // SAFETY: Only captureLegacyStateSnapshotIdentity constructs this private input.
    const params = JSON.parse(await text(process.stdin)) as LegacyStateSnapshotInput;
    process.stdout.write(JSON.stringify(await captureLegacyStateSnapshotIdentityInProcess(params)));
  } catch (error) {
    process.exitCode = 1;
    process.stderr.write(formatErrorMessage(error));
  }
}

if (process.argv[2] === "--openclaw-state-snapshot") {
  void runSnapshotWorker();
}
