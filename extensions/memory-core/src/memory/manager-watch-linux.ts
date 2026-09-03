// Memory Core plugin module owns the Linux per-directory tree watcher for memory.
import fsSync from "node:fs";
import path from "node:path";
import {
  createSubsystemLogger,
  type ResolvedMemorySearchConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { isFileMissingError } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { isKernelWatchCapacityError, shouldIgnoreMemoryWatchPath } from "./manager-watch-paths.js";
import type { MemoryWatchEventStats } from "./watch-settle.js";

const log = createSubsystemLogger("memory");

export type NativeMemoryWatchResult = "attached" | "missing" | "failed" | "capacity";

export type NativeMemoryWatchPair = {
  dir: string;
  main: fsSync.FSWatcher | null;
  parent: fsSync.FSWatcher | null;
  treeWatchers?: Map<string, LinuxMemoryDirectoryWatcher>;
};

type LinuxMemoryDirectoryWatcher = {
  watcher: fsSync.FSWatcher;
  ino: number;
};

export type MemoryWatchMarkDirty = (watchPath?: string, stats?: MemoryWatchEventStats) => void;

/**
 * Owner-provided surface for the Linux tree watcher. Keeping this narrow lets
 * the directory-tree algorithm live outside the manager class while the class
 * still owns pair bookkeeping, fallbacks, and capacity degradation.
 */
export type MemoryWatchAttachContext = {
  closed(): boolean;
  readonly multimodalSettings: ResolvedMemorySearchConfig["multimodal"] | undefined;
  createNativeWatch: typeof fsSync.watch;
  registerPair(pair: NativeMemoryWatchPair): void;
  closePair(pair: NativeMemoryWatchPair): void;
  /** Capacity-exhausted degrade: warn once, mark dirty, guarantee interval sync. */
  onCapacityExhausted(dir: string, markDirty: MemoryWatchMarkDirty): void;
  chokidarFallback(dir: string, markDirty: MemoryWatchMarkDirty): void;
  attachParentWatch(
    pair: NativeMemoryWatchPair,
    recordedInode: number,
    markDirty: MemoryWatchMarkDirty,
    reattach: () => NativeMemoryWatchResult,
  ): void;
};

export function attachLinuxMemoryDirectoryTreeWatchForDir(
  ctx: MemoryWatchAttachContext,
  dir: string,
  markDirty: MemoryWatchMarkDirty,
): NativeMemoryWatchResult {
  if (ctx.closed()) {
    return "failed";
  }
  let recordedInode: number | null;
  try {
    recordedInode = fsSync.statSync(dir).ino;
  } catch (err) {
    return isFileMissingError(err) ? "missing" : "failed";
  }

  let pair: NativeMemoryWatchPair | null = null;
  const treeWatchers = new Map<string, LinuxMemoryDirectoryWatcher>();
  let rootMissing = false;
  // Capacity exhaustion detected anywhere in the tree (root or child): the
  // kernel cannot grant more watch instances, so chokidar's per-file watches
  // would fail identically. The tree degrades to capacity polling instead.
  let capacityExhausted = false;

  const closeAndFallback = (message: string, err?: unknown) => {
    log.warn(message);
    if (pair) {
      ctx.closePair(pair);
    }
    if (ctx.closed()) {
      return;
    }
    markDirty();
    if (isKernelWatchCapacityError(err)) {
      ctx.onCapacityExhausted(dir, markDirty);
      return;
    }
    ctx.chokidarFallback(dir, markDirty);
  };

  const closeDirectorySubtree = (watchDir: string) => {
    const watchDirPrefix = `${watchDir}${path.sep}`;
    for (const [entryDir, entry] of Array.from(treeWatchers.entries())) {
      if (entryDir !== watchDir && !entryDir.startsWith(watchDirPrefix)) {
        continue;
      }
      try {
        entry.watcher.close();
      } catch {
        // ignore close failures
      }
      treeWatchers.delete(entryDir);
    }
  };

  const attachDirectory = (watchDir: string): fsSync.FSWatcher | null => {
    if (ctx.closed()) {
      return null;
    }
    let currentInode: number;
    try {
      const currentStat = fsSync.statSync(watchDir);
      if (!currentStat.isDirectory()) {
        return null;
      }
      currentInode = currentStat.ino;
    } catch (err) {
      rootMissing ||= watchDir === dir && isFileMissingError(err);
      return null;
    }
    const existing = treeWatchers.get(watchDir);
    if (existing) {
      if (existing.ino === currentInode) {
        return existing.watcher;
      }
      closeDirectorySubtree(watchDir);
    }
    let watcher: fsSync.FSWatcher | undefined;
    try {
      watcher = ctx.createNativeWatch(watchDir, { recursive: false }, (eventType, filename) => {
        if (ctx.closed() || (watcher && treeWatchers.get(watchDir)?.watcher !== watcher)) {
          return;
        }
        if (filename == null) {
          markDirty();
          if (!attachLinuxMemoryDirectoryTreeSubtree(ctx, watchDir, attachDirectory)) {
            closeAndFallback(`failed to refresh Linux memory directory watchers under ${watchDir}`);
          }
          return;
        }
        const full = path.join(watchDir, filename);
        let stats: fsSync.Stats | undefined;
        try {
          const s = fsSync.lstatSync(full, { throwIfNoEntry: false });
          stats = s ?? undefined;
        } catch {
          stats = undefined;
        }
        if (!stats) {
          closeDirectorySubtree(full);
        }
        if (stats?.isDirectory()) {
          if (eventType === "rename") {
            closeDirectorySubtree(full);
          }
          if (!attachLinuxMemoryDirectoryTreeSubtree(ctx, full, attachDirectory)) {
            closeAndFallback(`failed to attach Linux memory directory watcher under ${full}`);
            return;
          }
        }
        if (shouldIgnoreMemoryWatchPath(full, stats, ctx.multimodalSettings)) {
          return;
        }
        markDirty(full, stats);
      });
    } catch (err) {
      rootMissing ||= watchDir === dir && isFileMissingError(err);
      if (isKernelWatchCapacityError(err)) {
        capacityExhausted = true;
      }
      if (watchDir === dir && !rootMissing && !capacityExhausted) {
        // Single warn for the plain-failure path; capacity degradation warns
        // once through onCapacityExhausted instead of per directory.
        log.warn(`failed to start Linux memory directory watcher on ${watchDir}: ${String(err)}`);
      }
      return null;
    }
    treeWatchers.set(watchDir, { watcher, ino: currentInode });
    watcher.on("error", (err) => {
      if (treeWatchers.get(watchDir)?.watcher !== watcher) {
        return;
      }
      const detail = err instanceof Error ? err.message : String(err);
      closeAndFallback(`memory Linux directory watcher error on ${watchDir}: ${detail}`, err);
    });
    return watcher;
  };

  const mainWatcher = attachDirectory(dir);
  if (!mainWatcher) {
    if (capacityExhausted && !rootMissing) {
      return "capacity";
    }
    return rootMissing ? "missing" : "failed";
  }
  pair = { dir, main: mainWatcher, parent: null, treeWatchers };
  ctx.registerPair(pair);
  let subtreeAttached = attachLinuxMemoryDirectoryTreeSubtree(ctx, dir, attachDirectory);
  // Scan errors can refer to a missing child, not the root. Only the root's
  // identity can decide whether an existing parent should retain coverage.
  try {
    subtreeAttached = fsSync.statSync(dir).ino === recordedInode && subtreeAttached;
  } catch (err) {
    ctx.closePair(pair);
    if (!ctx.closed()) {
      markDirty();
    }
    return isFileMissingError(err) ? "missing" : "failed";
  }
  if (!subtreeAttached) {
    if (capacityExhausted) {
      // A child directory exhausted kernel watch capacity mid-setup: the
      // partially attached tree cannot stay ahead of the same limit, so the
      // whole directory degrades to capacity polling.
      ctx.closePair(pair);
      return "capacity";
    }
    closeAndFallback(`failed to attach Linux memory directory watcher subtree under ${dir}`);
    return "attached";
  }

  ctx.attachParentWatch(pair, recordedInode, markDirty, () =>
    attachLinuxMemoryDirectoryTreeWatchForDir(ctx, dir, markDirty),
  );
  return "attached";
}

function attachLinuxMemoryDirectoryTreeSubtree(
  ctx: MemoryWatchAttachContext,
  root: string,
  attachDirectory: (dir: string) => fsSync.FSWatcher | null,
): boolean {
  let rootStats: fsSync.Stats | undefined;
  try {
    rootStats = fsSync.lstatSync(root, { throwIfNoEntry: false }) ?? undefined;
  } catch {
    return false;
  }
  if (
    !rootStats?.isDirectory() ||
    shouldIgnoreMemoryWatchPath(root, rootStats, ctx.multimodalSettings)
  ) {
    // Not a directory (or an ignored path) has no subtree to attach; the
    // caller's root watcher already covers it, so this is success.
    return true;
  }
  if (!attachDirectory(root)) {
    return false;
  }
  let entries: fsSync.Dirent[];
  try {
    entries = fsSync.readdirSync(root, { withFileTypes: true });
  } catch {
    return false;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.isSymbolicLink()) {
      continue;
    }
    if (!attachLinuxMemoryDirectoryTreeSubtree(ctx, path.join(root, entry.name), attachDirectory)) {
      return false;
    }
  }
  return true;
}
