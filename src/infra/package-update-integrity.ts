import { createHash } from "node:crypto";
import { constants, type BigIntStats } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { createSubsystemLogger } from "../logging/subsystem.js";
import { ABSOLUTE_DEADLINE_EXPIRED, awaitWithinDeadline } from "../utils/absolute-deadline.js";
import { hasErrnoCode } from "./errors.js";
import { readPackageVersion } from "./package-json.js";

const MAX_TREE_BYTES = 1024 * 1024 * 1024;
const MAX_TREE_ENTRIES = 50_000;
const MAX_MANIFEST_BYTES = 1024 * 1024;
const MAX_LAUNCHER_BYTES = 1024 * 1024;
const MAX_SCAN_MS = 30_000;
const log = createSubsystemLogger("update/package-integrity");
let readerSequence = 0;

type PackageIntegrityFingerprint = { digest: string; identity: string; version: string };

export type PackageRootIntegrityFingerprint =
  | { kind: "directory"; tree: PackageIntegrityFingerprint }
  | { kind: "link"; metadata: string[]; target: string };

function identity(stat: BigIntStats): string {
  return `${stat.dev}:${stat.ino}`;
}

function metadata(stat: BigIntStats): string[] {
  return [
    identity(stat),
    stat.mode.toString(),
    stat.uid.toString(),
    stat.gid.toString(),
    stat.nlink.toString(),
    stat.size.toString(),
    stat.mtimeNs.toString(),
    stat.ctimeNs.toString(),
  ];
}

function unchanged(left: BigIntStats, right: BigIntStats): boolean {
  return left.ino !== 0n && metadata(left).join("/") === metadata(right).join("/");
}

/** Read-only, bounded observations. These do not exclude writers or seal an inode. */
export function createPackageIntegrityReader(timeoutMs = MAX_SCAN_MS) {
  const startedAtMonotonicMs = performance.now();
  const budget = Number.isFinite(timeoutMs)
    ? Math.min(MAX_SCAN_MS, Math.max(1, timeoutMs))
    : MAX_SCAN_MS;
  const deadline = Date.now() + budget;
  const timing = {
    readerId: `${process.pid}:${++readerSequence}`,
    timeOriginUnixMs: performance.timeOrigin,
    startedAtMonotonicMs,
    budgetMs: budget,
    deadlineClock: "wall",
    deadlineAtUnixMs: deadline,
  };
  let timeoutObservedAtMonotonicMs: number | undefined;
  let pendingIo = 0;

  async function trackIo<T>(operation: () => Promise<T>): Promise<T> {
    pendingIo++;
    try {
      return await operation();
    } finally {
      pendingIo--;
    }
  }

  async function observe<T>(
    phase: "baseline" | "retained" | "restored",
    operation: () => Promise<T>,
  ): Promise<T> {
    const emit = (event: string, facts?: Record<string, unknown>) => {
      try {
        log.debug(event, { ...timing, phase, event, ...facts });
      } catch {
        // A diagnostics sink must not replace the package result or primary error.
      }
    };
    emit("reader-started");
    let outcome = "failed";
    try {
      const result = await operation();
      outcome = "completed";
      return result;
    } finally {
      // Observe the completed scope, including its awaited cleanup, not merely
      // the timeout notification. Uncancelable OS work can still be pending.
      const settledAtMonotonicMs = performance.now();
      emit("reader-settled", {
        settledAtMonotonicMs,
        elapsedMs: settledAtMonotonicMs - startedAtMonotonicMs,
        outcome: timeoutObservedAtMonotonicMs === undefined ? outcome : "timed-out",
        timeoutObservedAtMonotonicMs,
        pendingIo,
      });
    }
  }

  async function read<T>(operation: () => Promise<T>, closeLate?: (value: T) => Promise<void>) {
    let pending: Promise<T> | undefined;
    const value = await awaitWithinDeadline(() => (pending = trackIo(operation)), deadline);
    if (value === ABSOLUTE_DEADLINE_EXPIRED) {
      timeoutObservedAtMonotonicMs ??= performance.now();
      // An OS read cannot always be canceled. Close late descriptors and never
      // continue the walk after returning a timeout to the swap owner.
      if (pending && closeLate) {
        void pending
          .then(
            (late) => trackIo(() => closeLate(late)),
            () => {},
          )
          .catch(() => {});
      }
      throw new Error("Package rollback verification timed out");
    }
    return value;
  }

  async function close(resource: { close: () => Promise<void> }) {
    const closing = trackIo(() => resource.close()).catch(() => {});
    if ((await awaitWithinDeadline(() => closing, deadline)) === ABSOLUTE_DEADLINE_EXPIRED) {
      timeoutObservedAtMonotonicMs ??= performance.now();
    }
  }

  async function entries(directoryPath: string, limit = MAX_TREE_ENTRIES): Promise<string[]> {
    const directory = await read(
      () => fs.opendir(directoryPath),
      (late) => late.close(),
    );
    const children: string[] = [];
    try {
      while (true) {
        const child = await read(() => directory.read());
        if (!child) {
          break;
        }
        if (children.length >= limit) {
          throw new Error("Package rollback verification entry limit exceeded");
        }
        children.push(child.name);
      }
    } finally {
      await close(directory);
    }
    return children.toSorted();
  }

  async function hashFile(file: string, stat: BigIntStats, remainingBytes: number) {
    if (!stat.isFile() || stat.size > BigInt(remainingBytes)) {
      throw new Error("Package rollback verification byte limit exceeded");
    }
    const handle = await read(
      () => fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK),
      (late) => late.close(),
    );
    try {
      if (!unchanged(stat, await read(() => handle.stat({ bigint: true })))) {
        throw new Error("Package rollback file changed before reading");
      }
      const hash = createHash("sha256");
      const buffer = Buffer.allocUnsafe(64 * 1024);
      let position = 0;
      while (true) {
        const { bytesRead } = await read(() =>
          handle.read(buffer, 0, Math.min(buffer.length, remainingBytes - position + 1), position),
        );
        if (bytesRead === 0) {
          break;
        }
        position += bytesRead;
        if (position > remainingBytes) {
          throw new Error("Package rollback verification byte limit exceeded");
        }
        hash.update(buffer.subarray(0, bytesRead));
      }
      if (!unchanged(stat, await read(() => handle.stat({ bigint: true })))) {
        throw new Error("Package rollback file changed while reading");
      }
      return { digest: hash.digest("hex"), bytes: position };
    } finally {
      await close(handle);
    }
  }

  async function tree(root: string, originalRoot = root): Promise<PackageIntegrityFingerprint> {
    const digest = createHash("sha256");
    const observed: Array<{ file: string; stat: BigIntStats }> = [];
    const hardlinks = new Map<string, string>();
    let bytes = 0;
    let remainingEntries = MAX_TREE_ENTRIES - 1;
    let device: bigint | undefined;
    let rootIdentity = "";

    async function visit(file: string, relative: string): Promise<void> {
      const stat = await read(() => fs.lstat(file, { bigint: true }));
      if (stat.ino === 0n || (device !== undefined && device !== stat.dev)) {
        throw new Error("Package rollback filesystem identity is unavailable");
      }
      if (!relative) {
        if (!stat.isDirectory() || stat.isSymbolicLink()) {
          throw new Error("Package rollback root is not a retained directory");
        }
        device = stat.dev;
        rootIdentity = identity(stat);
      }
      observed.push({ file, stat });
      // Renaming changes the root ctime. All descendant identities and clocks
      // must survive; root identity is compared separately from this digest.
      const fields = metadata(stat);
      if (!relative) {
        fields.pop();
      }
      digest.update(JSON.stringify([relative, fields]));
      if (stat.isSymbolicLink()) {
        const target = await read(() => fs.readlink(file));
        const resolved = path.relative(
          originalRoot,
          path.resolve(path.dirname(path.join(originalRoot, relative)), target),
        );
        // Reject segment/.. after a non-parent component: a symlink there can
        // make lexical normalization disagree with filesystem traversal.
        let descended = false;
        for (const segment of target.split(/[\\/]+/)) {
          if (!segment || segment === ".") {
            continue;
          }
          if (segment === ".." && descended) {
            throw new Error("Package rollback symlink has ambiguous parent traversal");
          }
          descended ||= segment !== "..";
        }
        if (
          path.isAbsolute(resolved) ||
          resolved === ".." ||
          resolved.startsWith(`..${path.sep}`)
        ) {
          throw new Error("Package rollback symlink leaves the retained tree");
        }
        digest.update(JSON.stringify(["symlink", target]));
      } else if (stat.isFile()) {
        const contents = await hashFile(file, stat, MAX_TREE_BYTES - bytes);
        bytes += contents.bytes;
        const key = identity(stat);
        const owner = stat.nlink > 1n ? (hardlinks.get(key) ?? relative) : null;
        if (owner !== null) {
          hardlinks.set(key, owner);
        }
        digest.update(JSON.stringify(["file", owner, contents.digest]));
      } else if (stat.isDirectory()) {
        const children = await entries(file, remainingEntries);
        // Reserve pending siblings before descending so wide ancestor lists
        // cannot each retain another full tree budget.
        remainingEntries -= children.length;
        for (const child of children) {
          await visit(path.join(file, child), relative ? `${relative}/${child}` : child);
        }
      } else {
        throw new Error("Package rollback contains a non-file entry");
      }
    }

    await visit(root, "");
    // JSON parsing buffers the manifest, unlike the streamed tree hash. Bound
    // that allocation separately, including growth after hashing.
    const version = await read(() => readPackageVersion(root, { maxBytes: MAX_MANIFEST_BYTES }));
    if (!version) {
      throw new Error("Package rollback version is unavailable");
    }
    for (const entry of observed) {
      if (!unchanged(entry.stat, await read(() => fs.lstat(entry.file, { bigint: true })))) {
        throw new Error("Package rollback tree changed during verification");
      }
    }
    return { digest: digest.digest("hex"), identity: rootIdentity, version };
  }

  async function rootEntry(
    root: string,
    originalRoot = root,
    expectedKind?: PackageRootIntegrityFingerprint["kind"],
  ): Promise<PackageRootIntegrityFingerprint> {
    const stat = await read(() => fs.lstat(root, { bigint: true }));
    if (expectedKind && expectedKind !== (stat.isSymbolicLink() ? "link" : "directory")) {
      throw new Error("Package rollback root entry kind changed");
    }
    if (!stat.isSymbolicLink()) {
      return { kind: "directory", tree: await tree(root, originalRoot) };
    }
    const target = await read(() => fs.readlink(root));
    if (!unchanged(stat, await read(() => fs.lstat(root, { bigint: true })))) {
      throw new Error("Package rollback link changed while reading");
    }
    // npm owns this pointer, not the external checkout it names. A sibling
    // rename changes ctime but must preserve the link identity and raw target.
    return { kind: "link", metadata: metadata(stat).slice(0, -1), target };
  }

  async function launcher(file: string): Promise<string> {
    const stat = await read(() => fs.lstat(file, { bigint: true }));
    const contents = stat.isSymbolicLink()
      ? await read(() => fs.readlink(file))
      : (await hashFile(file, stat, MAX_LAUNCHER_BYTES)).digest;
    if (!unchanged(stat, await read(() => fs.lstat(file, { bigint: true })))) {
      throw new Error("Package rollback launcher changed during verification");
    }
    // Launchers are copied, unlike the package tree. Their copy is compared
    // with the captured contents/target and permissions, not the new inode.
    return JSON.stringify([
      stat.isSymbolicLink() ? "symlink" : "file",
      stat.mode.toString(),
      stat.uid.toString(),
      stat.gid.toString(),
      contents,
    ]);
  }

  async function exists(file: string): Promise<boolean> {
    try {
      await read(() => fs.lstat(file));
      return true;
    } catch (error) {
      if (hasErrnoCode(error, "ENOENT")) {
        return false;
      }
      throw error;
    }
  }

  return { tree, rootEntry, launcher, exists, entries, observe };
}
