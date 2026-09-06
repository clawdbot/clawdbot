// Memory Core plugin module owns memory filesystem watch synchronization.
import fsSync from "node:fs";
import path from "node:path";
import chokidar from "chokidar";
import { isPathInside } from "openclaw/plugin-sdk/file-access-runtime";
import { classifyMemoryMultimodalPath } from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import {
  createSubsystemLogger,
  type ResolvedMemorySearchConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import {
  isFileMissingError,
  matchesExtraMemoryPathEntry,
  normalizeExtraMemoryPathEntries,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { resolveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import { formatCliCommand } from "openclaw/plugin-sdk/setup-tools";
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
  main: fsSync.FSWatcher | null;
  parent: fsSync.FSWatcher | null;
  treeWatchers?: Map<string, LinuxMemoryDirectoryWatcher>;
};

type NativeMemoryWatchResult = "attached" | "missing" | "failed";

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
    const fileWatchPaths = new Set<string>([
      path.join(this.workspaceDir, "MEMORY.md"),
      path.join(this.workspaceDir, "USER.md"),
    ]);
    const memoryDir = path.join(this.workspaceDir, "memory");
    const dirWatchPaths = new Set<string>([memoryDir]);
    const additionalPaths = normalizeExtraMemoryPathEntries(
      this.workspaceDir,
      this.settings.extraPaths,
    );
    for (const entry of additionalPaths) {
      try {
        const stat = fsSync.lstatSync(entry.path);
        if (stat.isSymbolicLink()) {
          continue;
        }
        if (stat.isDirectory()) {
          dirWatchPaths.add(entry.path);
          continue;
        }
        if (
          stat.isFile() &&
          (normalizeLowercaseStringOrEmpty(entry.path).endsWith(".md") ||
            classifyMemoryMultimodalPath(entry.path, this.settings.multimodal) !== null)
        ) {
          fileWatchPaths.add(entry.path);
        }
      } catch {
        // Skip missing/unreadable additional paths.
      }
    }
    const markDirty = (watchPath?: string, stats?: MemoryWatchEventStats) => {
      if (watchPath && stats && !stats.isDirectory?.()) {
        const normalizedWatchPath = path.resolve(watchPath);
        const matchingEntries = isPathInside(memoryDir, normalizedWatchPath)
          ? []
          : additionalPaths.filter((entry) => isPathInside(entry.path, normalizedWatchPath));
        if (
          matchingEntries.length > 0 &&
          !matchingEntries.some((entry) => matchesExtraMemoryPathEntry(entry, normalizedWatchPath))
        ) {
          return;
        }
      }
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
          : "failed";
      if (attached !== "attached") {
        // Native creation failed (dir missing, unsupported FS, throw) —
        // fall back to chokidar so directory coverage isn't dropped.
        fileWatchPaths.add(dir);
      }
    }
    if (fileWatchPaths.size > 0) {
      this.attachMemoryChokidarPaths(Array.from(fileWatchPaths), markDirty);
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
    const reindexCommand = formatCliCommand(
      `openclaw memory index --force --agent ${this.agentId}`,
    );
    warnIfMemoryWatchPressureHigh(
      this.memoryWatchPressureWarning,
      count,
      unit,
      "Large memory folders or extraPaths can make OpenClaw run out of file watchers or open files.",
      `Remove unnecessary memory.search.extraPaths entries or narrow their directory roots, including per-agent entries; otherwise review the host's file-watch/open-file limits. After changes, restart the Gateway. To refresh the affected index, run in the Gateway's environment: ${reindexCommand}.`,
      (message) => log.warn(message),
    );
  }

  // Pair recursive coverage with a parent watch that survives root replacement.
  protected attachNativeMemoryWatchForDir(
    dir: string,
    markDirty: (watchPath?: string, stats?: MemoryWatchEventStats) => void,
  ): NativeMemoryWatchResult {
    if (this.closed) {
      return "failed";
    }
    let recordedInode: number | null;
    try {
      recordedInode = fsSync.statSync(dir).ino;
    } catch (err) {
      // Startup falls back; an existing parent can wait for a missing root.
      return isFileMissingError(err) ? "missing" : "failed";
    }
    const pair: NativeMemoryWatchPair = { dir, main: null, parent: null };
    let mainWatcher: fsSync.FSWatcher | undefined;
    try {
      mainWatcher = resolveMemoryNativeWatchFactory()(
        dir,
        { recursive: true },
        (_eventType, filename) => {
          if (this.closed || (mainWatcher && pair.main !== mainWatcher)) {
            return;
          }
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
      if (isFileMissingError(err)) {
        return "missing";
      }
      log.warn(
        `failed to start native recursive watcher on ${dir}: ${String(err)}; falling back to chokidar`,
      );
      return "failed";
    }
    pair.main = mainWatcher;
    mainWatcher.on("error", (err) => {
      if (pair.main !== mainWatcher) {
        return;
      }
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
    this.attachNativeMemoryParentWatch(pair, recordedInode, markDirty, "native", () =>
      this.attachNativeMemoryWatchForDir(dir, markDirty),
    );
    return "attached";
  }

  private attachNativeMemoryParentWatch(
    pair: NativeMemoryWatchPair,
    recordedInode: number,
    markDirty: (watchPath?: string, stats?: MemoryWatchEventStats) => void,
    label: "native" | "Linux",
    reattach: () => NativeMemoryWatchResult,
  ): void {
    const { dir } = pair;
    let watchedInode: number | null = recordedInode;
    // Non-recursive parent watcher: catches root-directory replacement so
    // we can reattach the main watcher on the new inode. Without this,
    // `rm -rf memory && mkdir memory` would leave the main watcher bound
    // to the dead inode and silently miss subsequent file changes.
    try {
      const parentDir = path.dirname(dir);
      const baseName = path.basename(dir);
      const parentInode = fsSync.statSync(parentDir).ino;
      let parentWatcher: fsSync.FSWatcher | null = null;
      parentWatcher = resolveMemoryNativeWatchFactory()(
        parentDir,
        { recursive: false },
        (_eventType, filename) => {
          if (this.closed || (parentWatcher && pair.parent !== parentWatcher)) {
            return;
          }
          // Per Node docs `filename` can be null on some platforms even
          // when the parent watcher is otherwise supported. Treat null
          // as an unknown event and re-check the watched directory's inode;
          // otherwise filter by basename so sibling events don't trigger reattach.
          // A retained parent can itself be replaced while the root is absent.
          // Its self-rename must reach the inode check before we trust it again.
          if (
            filename !== null &&
            filename !== baseName &&
            (pair.main || filename !== path.basename(parentDir))
          ) {
            return;
          }
          let currentInode: number | null = null;
          let result: NativeMemoryWatchResult = "missing";
          try {
            currentInode = fsSync.statSync(dir).ino;
          } catch (err) {
            result = isFileMissingError(err) ? "missing" : "failed";
            if (result === "missing") {
              try {
                if (fsSync.statSync(parentDir).ino !== parentInode) {
                  result = "failed";
                }
              } catch {
                result = "failed";
              }
            }
          }
          if (currentInode === watchedInode && result !== "failed") {
            return;
          }
          // Keep the parent authoritative while the root is absent. Chokidar's
          // asynchronous missing-path setup can miss an immediate recreation.
          this.closeNativeMemoryWatchChildren(pair);
          watchedInode = null;
          markDirty();
          if (currentInode !== null) {
            result = reattach();
          }
          if (result === "missing") {
            return;
          }
          // New coverage must attach before the old parent closes: the root
          // can disappear again between the inode check and native attachment.
          this.closeNativeMemoryWatchPair(pair);
          if (result === "failed") {
            this.attachMemoryChokidarFallback(dir, markDirty);
          }
        },
      );
      const attachedParent = parentWatcher;
      attachedParent.on("error", (err) => {
        if (pair.parent !== attachedParent) {
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        log.warn(`memory ${label} parent watcher error on ${path.dirname(dir)}: ${message}`);
        try {
          attachedParent.close();
        } catch {
          // ignore
        }
        pair.parent = null;
        if (!pair.main) {
          this.closeNativeMemoryWatchPair(pair);
          if (!this.closed) {
            markDirty();
            this.attachMemoryChokidarFallback(dir, markDirty);
          }
        }
        // A live main watcher still covers normal events without its parent.
      });
      pair.parent = attachedParent;
    } catch (err) {
      // Parent watcher couldn't start (e.g. parentDir not accessible).
      // The main watcher still works for non-replacement events; just
      // log and continue.
      log.warn(
        `memory ${label} parent watcher could not start on ${path.dirname(dir)}: ${String(err)}`,
      );
    }
  }

  // Linux inotify reports direct child changes from a watched directory, but
  // it has no native recursive primitive. Watch directories only, then attach
  // newly-created subdirectories on demand; this avoids per-file watchers.
  protected attachLinuxMemoryDirectoryTreeWatchForDir(
    dir: string,
    markDirty: (watchPath?: string, stats?: MemoryWatchEventStats) => void,
  ): NativeMemoryWatchResult {
    if (this.closed) {
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
        watcher = resolveMemoryNativeWatchFactory()(
          watchDir,
          { recursive: false },
          (eventType, filename) => {
            if (this.closed || (watcher && treeWatchers.get(watchDir)?.watcher !== watcher)) {
              return;
            }
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
        rootMissing ||= watchDir === dir && isFileMissingError(err);
        if (watchDir === dir && !rootMissing) {
          log.warn(
            `failed to start Linux memory directory watcher on ${watchDir}: ${String(err)}; falling back to chokidar`,
          );
        }
        return null;
      }
      treeWatchers.set(watchDir, { watcher, ino: currentInode });
      watcher.on("error", (err) => {
        if (treeWatchers.get(watchDir)?.watcher !== watcher) {
          return;
        }
        const detail = err instanceof Error ? err.message : String(err);
        closeAndFallback(`memory Linux directory watcher error on ${watchDir}: ${detail}`);
      });
      return watcher;
    };

    const mainWatcher = attachDirectory(dir);
    if (!mainWatcher) {
      return rootMissing ? "missing" : "failed";
    }
    pair = { dir, main: mainWatcher, parent: null, treeWatchers };
    this.nativeMemoryWatchPairs.push(pair);
    let subtreeAttached = this.attachLinuxMemoryDirectoryTreeSubtree(dir, attachDirectory);
    // Scan errors can refer to a missing child, not the root. Only the root's
    // identity can decide whether an existing parent should retain coverage.
    try {
      subtreeAttached = fsSync.statSync(dir).ino === recordedInode && subtreeAttached;
    } catch (err) {
      this.closeNativeMemoryWatchPair(pair);
      if (!this.closed) {
        markDirty();
      }
      return isFileMissingError(err) ? "missing" : "failed";
    }
    if (!subtreeAttached) {
      closeAndFallback(
        `failed to attach Linux memory directory watcher subtree under ${dir}; falling back to chokidar`,
      );
      return "attached";
    }

    this.attachNativeMemoryParentWatch(pair, recordedInode, markDirty, "Linux", () =>
      this.attachLinuxMemoryDirectoryTreeWatchForDir(dir, markDirty),
    );
    return "attached";
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

  private closeNativeMemoryWatchChildren(pair: NativeMemoryWatchPair): void {
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
        pair.main?.close();
      } catch {
        // ignore close failures
      }
    }
    pair.main = null;
  }

  private closeNativeMemoryWatchPair(pair: NativeMemoryWatchPair): void {
    this.closeNativeMemoryWatchChildren(pair);
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

  private removeNativeMemoryWatchPair(pair: NativeMemoryWatchPair): void {
    const idx = this.nativeMemoryWatchPairs.indexOf(pair);
    if (idx >= 0) {
      this.nativeMemoryWatchPairs.splice(idx, 1);
    }
  }

  // Reattach `dir` to chokidar after a native watcher dies, so
  // subsequent memory changes under `dir` continue to drive watch sync.
  protected attachMemoryChokidarFallback(
    dir: string,
    markDirty: (watchPath?: string, stats?: MemoryWatchEventStats) => void,
  ): void {
    if (this.closed) {
      // Manager teardown started — don't create new watcher resources.
      return;
    }
    try {
      this.attachMemoryChokidarPaths(dir, markDirty);
    } catch (err) {
      log.warn(`failed to attach chokidar fallback for ${dir}: ${String(err)}`);
    }
  }

  private attachMemoryChokidarPaths(
    paths: string | string[],
    markDirty: (watchPath?: string, stats?: MemoryWatchEventStats) => void,
  ): void {
    // Linux subtree startup can create the fallback before ensureWatcher
    // attaches file paths. Reuse that watcher rather than replacing it.
    if (this.watcher) {
      this.watcher.add(paths);
      return;
    }
    const watcher = resolveMemoryWatchFactory()(typeof paths === "string" ? [paths] : paths, {
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
      // File watcher errors must not crash the gateway; manual search still works.
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`memory watcher error: ${message}`);
    });
    watcher.once("ready", () => {
      this.warnIfMemoryWatchPressure(countChokidarWatchedEntries(watcher), "paths");
    });
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
