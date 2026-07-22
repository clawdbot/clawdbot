// Memory Core plugin module owns memory filesystem watch synchronization.
import fsSync from "node:fs";
import path from "node:path";
import chokidar, { type FSWatcher } from "chokidar";
import { classifyMemoryMultimodalPath } from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import {
  createSubsystemLogger,
  type ResolvedMemorySearchConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { normalizeExtraMemoryPaths } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { resolveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { MemoryManagerSyncBase } from "./manager-sync-base.js";
import {
  countChokidarWatchedEntries,
  type MemoryWatchPressureUnit,
  type MemoryWatchPressureWarningState,
  warnIfMemoryWatchPressureHigh,
} from "./watch-pressure.js";
import {
  recordMemoryWatchEventPath,
  settleMemoryWatchEventPaths,
  type MemoryWatchEventStats,
} from "./watch-settle.js";

const MEMORY_WATCH_PRESSURE_STARTUP_CHECK_DELAY_MS = 10_000;
const IGNORED_MEMORY_WATCH_DIR_NAMES = new Set([
  ".git",
  "node_modules",
  ".pnpm-store",
  ".venv",
  "venv",
  ".tox",
  "__pycache__",
]);
const log = createSubsystemLogger("memory");
const TEST_MEMORY_WATCH_FACTORY_KEY = Symbol.for("openclaw.test.memoryWatchFactory");
const TEST_MEMORY_NATIVE_WATCH_FACTORY_KEY = Symbol.for("openclaw.test.memoryNativeWatchFactory");

type NativeMemoryWatchPair = {
  dir: string;
  main: fsSync.FSWatcher;
  parent: fsSync.FSWatcher | null;
  treeWatchers?: Map<string, LinuxMemoryDirectoryWatcher>;
};

type LinuxMemoryDirectoryWatcher = {
  watcher: fsSync.FSWatcher;
  ino: number;
};

function resolveMemoryWatchFactory(): typeof chokidar.watch {
  if (process.env.VITEST === "true" || process.env.NODE_ENV === "test") {
    const override = (globalThis as Record<PropertyKey, unknown>)[TEST_MEMORY_WATCH_FACTORY_KEY];
    if (typeof override === "function") {
      return override as typeof chokidar.watch;
    }
  }
  return chokidar.watch.bind(chokidar);
}

function resolveMemoryNativeWatchFactory(): typeof fsSync.watch {
  if (process.env.VITEST === "true" || process.env.NODE_ENV === "test") {
    const override = (globalThis as Record<PropertyKey, unknown>)[
      TEST_MEMORY_NATIVE_WATCH_FACTORY_KEY
    ];
    if (typeof override === "function") {
      return override as typeof fsSync.watch;
    }
  }
  return fsSync.watch.bind(fsSync);
}

function shouldIgnoreMemoryWatchPath(
  watchPath: string,
  stats?: { isDirectory?: () => boolean },
  multimodalSettings?: ResolvedMemorySearchConfig["multimodal"],
): boolean {
  const normalized = path.normalize(watchPath);
  const parts = normalized
    .split(path.sep)
    .map((segment) => normalizeLowercaseStringOrEmpty(segment));
  if (parts.some((segment) => IGNORED_MEMORY_WATCH_DIR_NAMES.has(segment))) {
    return true;
  }
  if (stats?.isDirectory?.()) {
    return false;
  }
  if (!stats) {
    return false;
  }
  const extension = normalizeLowercaseStringOrEmpty(path.extname(normalized));
  if (extension.length === 0 || extension === ".md") {
    return false;
  }
  if (!multimodalSettings) {
    return true;
  }
  return classifyMemoryMultimodalPath(normalized, multimodalSettings) === null;
}

function runDetachedMemorySync(sync: () => Promise<void>, reason: "interval" | "watch") {
  void sync().catch((err: unknown) => {
    log.warn(`memory sync failed (${reason}): ${String(err)}`);
  });
}

export abstract class MemoryManagerWatchOps extends MemoryManagerSyncBase {
  private nativeMemoryWatchPairs: NativeMemoryWatchPair[] = [];
  private readonly memoryWatchPressureWarning: MemoryWatchPressureWarningState = { shown: false };
  protected ensureWatcher() {
    if (!this.sources.has("memory") || !this.settings.sync.watch) {
      return;
    }
    if (this.watcher || this.nativeMemoryWatchPairs.length > 0) {
      // Already initialized — preserve idempotence.
      return;
    }
    // Core paths preserve original symlink-follow behavior (chokidar/fs.watch
    // resolve through symlinks by default); extraPaths preserves the original
    // explicit symlink-skip policy.
    const fileWatchPaths = new Set<string>([path.join(this.workspaceDir, "MEMORY.md")]);
    const dirWatchPaths = new Set<string>([path.join(this.workspaceDir, "memory")]);
    const additionalPaths = normalizeExtraMemoryPaths(this.workspaceDir, this.settings.extraPaths);
    for (const entry of additionalPaths) {
      try {
        const stat = fsSync.lstatSync(entry);
        if (stat.isSymbolicLink()) {
          continue;
        }
        if (stat.isDirectory()) {
          dirWatchPaths.add(entry);
          continue;
        }
        if (
          stat.isFile() &&
          (normalizeLowercaseStringOrEmpty(entry).endsWith(".md") ||
            classifyMemoryMultimodalPath(entry, this.settings.multimodal) !== null)
        ) {
          fileWatchPaths.add(entry);
        }
      } catch {
        // Skip missing/unreadable additional paths.
      }
    }
    const markDirty = (watchPath?: string, stats?: MemoryWatchEventStats) => {
      recordMemoryWatchEventPath(this.pendingWatchPaths, watchPath, stats);
      this.dirty = true;
      this.scheduleWatchSync();
    };
    // Native recursive fs.watch for directory paths — one watcher per
    // directory on macOS (FSEvents) and Windows (ReadDirectoryChangesW).
    // Avoids chokidar's per-file fs.watch fan-out on large memory trees.
    //
    // Linux is intentionally handled by a separate directory-tree watcher
    // below: Node's `fs.watch(dir, { recursive: true })` routes through
    // `internal/fs/recursive_watch` and watches every file. Watching
    // directories only preserves Linux inotify semantics while avoiding
    // per-file watch descriptor fan-out.
    //
    // On any other native creation failure (e.g. unsupported filesystem,
    // ERR_FEATURE_UNAVAILABLE_ON_PLATFORM) the directory also falls back to
    // chokidar so freshness is preserved on the degraded path.
    const nativeRecursiveSupported = process.platform === "darwin" || process.platform === "win32";
    for (const dir of dirWatchPaths) {
      const attached = nativeRecursiveSupported
        ? this.attachNativeMemoryWatchForDir(dir, markDirty)
        : process.platform === "linux"
          ? this.attachLinuxMemoryDirectoryTreeWatchForDir(dir, markDirty)
          : false;
      if (!attached) {
        // Native creation failed (dir missing, unsupported FS, throw) —
        // fall back to chokidar so directory coverage isn't dropped.
        fileWatchPaths.add(dir);
      }
    }
    if (fileWatchPaths.size > 0) {
      const existingWatcher = this.currentMemoryChokidarWatcher();
      if (existingWatcher) {
        existingWatcher.add(Array.from(fileWatchPaths));
      } else {
        const watcher = resolveMemoryWatchFactory()(Array.from(fileWatchPaths), {
          ignoreInitial: true,
          ignored: (watchPath, stats) =>
            shouldIgnoreMemoryWatchPath(watchPath, stats, this.settings.multimodal),
        });
        this.watcher = watcher;
        watcher.on("add", markDirty);
        watcher.on("change", markDirty);
        watcher.on("unlink", markDirty);
        watcher.on("unlinkDir", markDirty);
        watcher.on("error", (err) => {
          // File watcher errors (e.g., ENOSPC) should not crash the gateway.
          // Log the error and continue - memory search still works without auto-sync.
          const message = err instanceof Error ? err.message : String(err);
          log.warn(`memory watcher error: ${message}`);
        });
        watcher.once("ready", () => {
          this.warnIfMemoryWatchPressure(countChokidarWatchedEntries(watcher), "paths");
        });
      }
    }
    this.scheduleMemoryWatchPressureStartupCheck();
  }

  private scheduleMemoryWatchPressureStartupCheck(): void {
    if (
      this.memoryWatchPressureStartupTimer ||
      this.memoryWatchPressureWarning.shown ||
      this.closed ||
      (this.nativeMemoryWatchPairs.length === 0 && !this.watcher)
    ) {
      return;
    }
    this.memoryWatchPressureStartupTimer = setTimeout(() => {
      this.memoryWatchPressureStartupTimer = null;
      if (this.closed || this.memoryWatchPressureWarning.shown) {
        return;
      }
      if (this.watcher) {
        this.warnIfMemoryWatchPressure(countChokidarWatchedEntries(this.watcher), "paths");
      }
      if (this.memoryWatchPressureWarning.shown) {
        return;
      }
      let directoryCount = 0;
      for (const pair of this.nativeMemoryWatchPairs) {
        directoryCount += pair.treeWatchers?.size ?? 0;
      }
      this.warnIfMemoryWatchPressure(directoryCount, "directories");
    }, MEMORY_WATCH_PRESSURE_STARTUP_CHECK_DELAY_MS);
  }

  private warnIfMemoryWatchPressure(count: number, unit: MemoryWatchPressureUnit): void {
    warnIfMemoryWatchPressureHigh(
      this.memoryWatchPressureWarning,
      count,
      unit,
      "Large memory folders or extraPaths can make OpenClaw run out of file watchers or open files.",
      "Remove large extraPaths, or set memory.search.sync.watch to false and refresh memory manually.",
      (message) => log.warn(message),
    );
  }

  private currentMemoryChokidarWatcher(): FSWatcher | null {
    return this.watcher;
  }

  // Attach a native recursive `fs.watch` to `dir` plus a non-recursive
  // parent-directory watch that detects root-replacement
  // (`rm -rf memory && mkdir memory`) by inode comparison. Returns true if
  // the main native watcher attached. Called from ensureWatcher(); also
  // re-entered from the parent-watch handler on detected replacement.
  protected attachNativeMemoryWatchForDir(
    dir: string,
    markDirty: (watchPath?: string, stats?: MemoryWatchEventStats) => void,
  ): boolean {
    if (this.closed) {
      return false;
    }
    let recordedInode: number | null;
    try {
      recordedInode = fsSync.statSync(dir).ino;
    } catch {
      // Dir doesn't exist; caller will fall back to chokidar.
      return false;
    }
    let mainWatcher: fsSync.FSWatcher;
    try {
      mainWatcher = resolveMemoryNativeWatchFactory()(
        dir,
        { recursive: true },
        (_eventType, filename) => {
          if (filename == null) {
            // Node docs: filename may be null on some platforms even when
            // recursive watching is otherwise supported. Be conservative
            // and mark broadly dirty rather than dropping the event.
            markDirty();
            return;
          }
          const full = path.join(dir, filename);
          let stats: fsSync.Stats | undefined;
          try {
            const s = fsSync.lstatSync(full, { throwIfNoEntry: false });
            stats = s ?? undefined;
          } catch {
            stats = undefined;
          }
          if (shouldIgnoreMemoryWatchPath(full, stats, this.settings.multimodal)) {
            return;
          }
          // Pass stats so the watch-settle queue can debounce rapid
          // writes; without a snapshot the queue cannot detect stability.
          markDirty(full, stats);
        },
      );
    } catch (err) {
      log.warn(
        `failed to start native recursive watcher on ${dir}: ${String(err)}; falling back to chokidar`,
      );
      return false;
    }
    const pair: NativeMemoryWatchPair = { dir, main: mainWatcher, parent: null };
    mainWatcher.on("error", (err) => {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`memory native watcher error on ${dir}: ${message}`);
      // Per Node docs the FSWatcher is no longer usable after an error.
      this.closeNativeMemoryWatchPair(pair);
      if (this.closed) {
        return;
      }
      // Force a broad re-sync to cover the gap, then restore directory
      // coverage by reattaching to chokidar so subsequent file changes
      // still drive watch sync (intervalMinutes defaults to 0; without
      // a watcher the directory would stop being indexed).
      markDirty();
      this.attachMemoryChokidarFallback(dir, markDirty);
    });
    this.nativeMemoryWatchPairs.push(pair);
    // Non-recursive parent watcher: catches root-directory replacement so
    // we can reattach the main watcher on the new inode. Without this,
    // `rm -rf memory && mkdir memory` would leave the main watcher bound
    // to the dead inode and silently miss subsequent file changes.
    try {
      const parentDir = path.dirname(dir);
      const baseName = path.basename(dir);
      const parentWatcher = resolveMemoryNativeWatchFactory()(
        parentDir,
        { recursive: false },
        (_eventType, filename) => {
          // Per Node docs `filename` can be null on some platforms even
          // when the parent watcher is otherwise supported. Treat null
          // as an unknown event and re-check the watched directory's inode;
          // otherwise filter by basename so sibling events don't trigger reattach.
          if (filename !== null && filename !== baseName) {
            return;
          }
          let currentInode: number | null;
          try {
            currentInode = fsSync.statSync(dir).ino;
          } catch {
            currentInode = null;
          }
          if (currentInode === recordedInode) {
            return;
          }
          // Root was replaced (or removed). Tear down the existing pair
          // and either reattach (if dir still exists) or fall back to
          // chokidar (if dir is gone).
          this.closeNativeMemoryWatchPair(pair);
          if (this.closed) {
            return;
          }
          markDirty();
          if (currentInode !== null) {
            // Re-attach on the new inode (this also installs a fresh
            // parent watcher closed over the new recordedInode). If the
            // helper's own statSync races with the dir disappearing
            // between our inode check and its own check, it returns
            // false — fall back to chokidar so coverage isn't lost.
            if (!this.attachNativeMemoryWatchForDir(dir, markDirty)) {
              this.attachMemoryChokidarFallback(dir, markDirty);
            }
          } else {
            this.attachMemoryChokidarFallback(dir, markDirty);
          }
        },
      );
      parentWatcher.on("error", (err) => {
        const message = err instanceof Error ? err.message : String(err);
        log.warn(`memory native parent watcher error on ${path.dirname(dir)}: ${message}`);
        try {
          parentWatcher.close();
        } catch {
          // ignore
        }
        this.removeNativeMemoryParentWatch(parentWatcher);
        if (pair.parent === parentWatcher) {
          pair.parent = null;
        }
        // Main watcher still alive — root-replacement detection is lost
        // but normal events still flow. No fallback needed.
      });
      pair.parent = parentWatcher;
    } catch (err) {
      // Parent watcher couldn't start (e.g. parentDir not accessible).
      // The main watcher still works for non-replacement events; just
      // log and continue.
      log.warn(
        `memory native parent watcher could not start on ${path.dirname(dir)}: ${String(err)}`,
      );
    }
    return true;
  }

  // Linux inotify reports direct child changes from a watched directory, but
  // it has no native recursive primitive. Watch directories only, then attach
  // newly-created subdirectories on demand; this avoids per-file watchers.
  protected attachLinuxMemoryDirectoryTreeWatchForDir(
    dir: string,
    markDirty: (watchPath?: string, stats?: MemoryWatchEventStats) => void,
  ): boolean {
    if (this.closed) {
      return false;
    }
    let recordedInode: number | null;
    try {
      recordedInode = fsSync.statSync(dir).ino;
    } catch {
      return false;
    }

    let pair: NativeMemoryWatchPair | null = null;
    const treeWatchers = new Map<string, LinuxMemoryDirectoryWatcher>();

    const closeAndFallback = (message: string) => {
      log.warn(message);
      if (pair) {
        this.closeNativeMemoryWatchPair(pair);
      }
      if (this.closed) {
        return;
      }
      markDirty();
      this.attachMemoryChokidarFallback(dir, markDirty);
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
      if (this.closed) {
        return null;
      }
      let currentInode: number;
      try {
        const currentStat = fsSync.statSync(watchDir);
        if (!currentStat.isDirectory()) {
          return null;
        }
        currentInode = currentStat.ino;
      } catch {
        return null;
      }
      const existing = treeWatchers.get(watchDir);
      if (existing) {
        if (existing.ino === currentInode) {
          return existing.watcher;
        }
        closeDirectorySubtree(watchDir);
      }
      let watcher: fsSync.FSWatcher;
      try {
        watcher = resolveMemoryNativeWatchFactory()(
          watchDir,
          { recursive: false },
          (eventType, filename) => {
            if (filename == null) {
              markDirty();
              if (!this.attachLinuxMemoryDirectoryTreeSubtree(watchDir, attachDirectory)) {
                closeAndFallback(
                  `failed to refresh Linux memory directory watchers under ${watchDir}; falling back to chokidar`,
                );
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
              if (!this.attachLinuxMemoryDirectoryTreeSubtree(full, attachDirectory)) {
                closeAndFallback(
                  `failed to attach Linux memory directory watcher under ${full}; falling back to chokidar`,
                );
                return;
              }
            }
            if (shouldIgnoreMemoryWatchPath(full, stats, this.settings.multimodal)) {
              return;
            }
            markDirty(full, stats);
          },
        );
      } catch (err) {
        if (watchDir === dir) {
          log.warn(
            `failed to start Linux memory directory watcher on ${watchDir}: ${String(err)}; falling back to chokidar`,
          );
        }
        return null;
      }
      treeWatchers.set(watchDir, { watcher, ino: currentInode });
      watcher.on("error", (err) => {
        const detail = err instanceof Error ? err.message : String(err);
        closeAndFallback(`memory Linux directory watcher error on ${watchDir}: ${detail}`);
      });
      return watcher;
    };

    const mainWatcher = attachDirectory(dir);
    if (!mainWatcher) {
      return false;
    }
    pair = { dir, main: mainWatcher, parent: null, treeWatchers };
    this.nativeMemoryWatchPairs.push(pair);
    if (!this.attachLinuxMemoryDirectoryTreeSubtree(dir, attachDirectory)) {
      closeAndFallback(
        `failed to attach Linux memory directory watcher subtree under ${dir}; falling back to chokidar`,
      );
      return true;
    }

    try {
      const parentDir = path.dirname(dir);
      const baseName = path.basename(dir);
      const parentWatcher = resolveMemoryNativeWatchFactory()(
        parentDir,
        { recursive: false },
        (_eventType, filename) => {
          if (filename !== null && filename !== baseName) {
            return;
          }
          let currentInode: number | null;
          try {
            currentInode = fsSync.statSync(dir).ino;
          } catch {
            currentInode = null;
          }
          if (currentInode === recordedInode) {
            return;
          }
          this.closeNativeMemoryWatchPair(pair);
          if (this.closed) {
            return;
          }
          markDirty();
          if (currentInode !== null) {
            if (!this.attachLinuxMemoryDirectoryTreeWatchForDir(dir, markDirty)) {
              this.attachMemoryChokidarFallback(dir, markDirty);
            }
          } else {
            this.attachMemoryChokidarFallback(dir, markDirty);
          }
        },
      );
      parentWatcher.on("error", (err) => {
        const message = err instanceof Error ? err.message : String(err);
        log.warn(`memory Linux parent watcher error on ${path.dirname(dir)}: ${message}`);
        try {
          parentWatcher.close();
        } catch {
          // ignore
        }
        this.removeNativeMemoryParentWatch(parentWatcher);
        if (pair?.parent === parentWatcher) {
          pair.parent = null;
        }
      });
      pair.parent = parentWatcher;
    } catch (err) {
      log.warn(
        `memory Linux parent watcher could not start on ${path.dirname(dir)}: ${String(err)}`,
      );
    }
    return true;
  }

  private attachLinuxMemoryDirectoryTreeSubtree(
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
      shouldIgnoreMemoryWatchPath(root, rootStats, this.settings.multimodal)
    ) {
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
      if (
        !this.attachLinuxMemoryDirectoryTreeSubtree(path.join(root, entry.name), attachDirectory)
      ) {
        return false;
      }
    }
    return true;
  }

  private closeNativeMemoryWatchPair(pair: NativeMemoryWatchPair): void {
    if (pair.treeWatchers) {
      for (const entry of pair.treeWatchers.values()) {
        try {
          entry.watcher.close();
        } catch {
          // ignore close failures
        }
      }
      pair.treeWatchers.clear();
    } else {
      try {
        pair.main.close();
      } catch {
        // ignore close failures
      }
    }
    if (pair.parent) {
      try {
        pair.parent.close();
      } catch {
        // ignore close failures
      }
      pair.parent = null;
    }
    this.removeNativeMemoryWatchPair(pair);
  }

  protected closeNativeMemoryWatchPairs(): void {
    while (this.nativeMemoryWatchPairs.length > 0) {
      const pair = this.nativeMemoryWatchPairs[0];
      if (!pair) {
        return;
      }
      this.closeNativeMemoryWatchPair(pair);
    }
  }

  private removeNativeMemoryParentWatch(w: fsSync.FSWatcher): void {
    for (const pair of this.nativeMemoryWatchPairs) {
      if (pair.parent === w) {
        pair.parent = null;
        return;
      }
    }
  }

  private removeNativeMemoryWatchPair(pair: NativeMemoryWatchPair): void {
    const idx = this.nativeMemoryWatchPairs.indexOf(pair);
    if (idx >= 0) {
      this.nativeMemoryWatchPairs.splice(idx, 1);
    }
  }

  // Reattach `dir` to chokidar after a native recursive watcher dies, so
  // subsequent memory changes under `dir` continue to drive watch sync.
  // Called from the native watcher `error` handler in ensureWatcher();
  // factored out so the fallback shape can be unit-tested in isolation.
  protected attachMemoryChokidarFallback(
    dir: string,
    markDirty: (watchPath?: string, stats?: MemoryWatchEventStats) => void,
  ): void {
    if (this.closed) {
      // Manager teardown started — don't create new watcher resources.
      return;
    }
    try {
      if (this.watcher) {
        // Existing chokidar watcher (handling MEMORY.md and/or other file
        // paths) — extend it to cover this directory too.
        this.watcher.add(dir);
        return;
      }
      // No chokidar watcher exists yet. Spin one up just for this directory
      // so the periodic-sync gap is closed.
      const watcher = resolveMemoryWatchFactory()([dir], {
        ignoreInitial: true,
        ignored: (watchPath, stats) =>
          shouldIgnoreMemoryWatchPath(watchPath, stats, this.settings.multimodal),
      });
      this.watcher = watcher;
      watcher.on("add", markDirty);
      watcher.on("change", markDirty);
      watcher.on("unlink", markDirty);
      watcher.on("unlinkDir", markDirty);
      watcher.on("error", (err) => {
        const message = err instanceof Error ? err.message : String(err);
        log.warn(`memory watcher error: ${message}`);
      });
      watcher.once("ready", () => {
        this.warnIfMemoryWatchPressure(countChokidarWatchedEntries(watcher), "paths");
      });
    } catch (err) {
      log.warn(`failed to attach chokidar fallback for ${dir}: ${String(err)}`);
    }
  }

  protected ensureIntervalSync() {
    const minutes = this.settings.sync.intervalMinutes;
    if (!minutes || minutes <= 0 || this.intervalTimer) {
      return;
    }
    const ms = resolveTimerTimeoutMs(minutes * 60 * 1000, 0, 0);
    if (ms <= 0) {
      return;
    }
    this.intervalTimer = setInterval(() => {
      runDetachedMemorySync(() => this.sync({ reason: "interval" }), "interval");
    }, ms);
  }

  private scheduleWatchSync() {
    if (!this.sources.has("memory") || !this.settings.sync.watch) {
      return;
    }
    if (this.watchTimer) {
      clearTimeout(this.watchTimer);
    }
    this.watchTimer = setTimeout(() => {
      this.watchTimer = null;
      runDetachedMemorySync(async () => {
        if (this.closed) {
          return;
        }
        if (!(await settleMemoryWatchEventPaths(this.pendingWatchPaths))) {
          if (!this.closed) {
            this.scheduleWatchSync();
          }
          return;
        }
        if (this.closed) {
          return;
        }
        await this.sync({ reason: "watch" });
      }, "watch");
    }, this.settings.sync.watchDebounceMs);
  }
}
