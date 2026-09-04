// Memory Core plugin module owns memory filesystem watch synchronization.
import fsSync from "node:fs";
import path from "node:path";
import chokidar from "chokidar";
import { isPathInside } from "openclaw/plugin-sdk/file-access-runtime";
import { classifyMemoryMultimodalPath } from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import { createSubsystemLogger } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import {
  isFileMissingError,
  matchesExtraMemoryPathEntry,
  normalizeExtraMemoryPathEntries,
} from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { resolveTimerTimeoutMs } from "openclaw/plugin-sdk/number-runtime";
import { normalizeLowercaseStringOrEmpty } from "openclaw/plugin-sdk/string-coerce-runtime";
import { MemoryManagerSyncBase } from "./manager-sync-base.js";
import {
  attachLinuxMemoryDirectoryTreeWatchForDir,
  type MemoryWatchAttachContext,
  type NativeMemoryWatchPair,
  type NativeMemoryWatchResult,
} from "./manager-watch-linux.js";
import { isKernelWatchCapacityError, shouldIgnoreMemoryWatchPath } from "./manager-watch-paths.js";
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
const log = createSubsystemLogger("memory");
const TEST_MEMORY_WATCH_FACTORY_KEY = Symbol.for("openclaw.test.memoryWatchFactory");
const TEST_MEMORY_NATIVE_WATCH_FACTORY_KEY = Symbol.for("openclaw.test.memoryNativeWatchFactory");

// When the kernel cannot grant another inotify/watch instance (shared-tenant
// containers exhausting fs.inotify.max_user_instances, or global fd limits),
// every per-file chokidar fs.watch would fail the same way, so the only useful
// degrade is skipping the fallback entirely and refreshing via interval sync.
const MEMORY_WATCH_CAPACITY_FALLBACK_INTERVAL_MINUTES = 5;

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

function runDetachedMemorySync(sync: () => Promise<void>, reason: "interval" | "watch") {
  void sync().catch((err: unknown) => {
    log.warn(`memory sync failed (${reason}): ${String(err)}`);
  });
}

export abstract class MemoryManagerWatchOps extends MemoryManagerSyncBase {
  private nativeMemoryWatchPairs: NativeMemoryWatchPair[] = [];
  private readonly memoryWatchPressureWarning: MemoryWatchPressureWarningState = { shown: false };
  // Directories degraded to polling after kernel watch capacity exhaustion.
  // Tracked per root: reattaching one root must not stop the forced rescans
  // that other still-degraded roots depend on.
  private readonly capacityDegradedDirs = new Set<string>();
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
    let capacityDegraded = false;
    for (const dir of dirWatchPaths) {
      const attached = nativeRecursiveSupported
        ? this.attachNativeMemoryWatchForDir(dir, markDirty)
        : process.platform === "linux"
          ? this.attachLinuxMemoryDirectoryTreeWatchForDir(dir, markDirty)
          : "failed";
      if (attached === "capacity") {
        this.degradeMemoryWatchToPollingSync(dir, markDirty);
        capacityDegraded = true;
        continue;
      }
      if (attached !== "attached") {
        // Native creation failed (dir missing, unsupported FS, throw) —
        // fall back to chokidar so directory coverage isn't dropped.
        fileWatchPaths.add(dir);
      }
    }
    if (fileWatchPaths.size > 0 && !capacityDegraded && this.capacityDegradedDirs.size === 0) {
      // Under exhausted kernel watch capacity every chokidar per-file watch
      // would fail identically; interval sync covers those paths instead.
      // The degraded-roots set also covers late degradation from inside a
      // nominally attached root (e.g. synchronous parent-watch failure).
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
    warnIfMemoryWatchPressureHigh(
      this.memoryWatchPressureWarning,
      count,
      unit,
      "Large memory folders or extraPaths can make OpenClaw run out of file watchers or open files.",
      "Remove large extraPaths, or set memory.search.sync.watch to false and refresh memory manually.",
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
      if (isKernelWatchCapacityError(err)) {
        return "capacity";
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
      // Capacity exhaustion reports once through the degrade warning; the
      // raw error line would double-report the same condition.
      if (!isKernelWatchCapacityError(err)) {
        log.warn(`memory native watcher error on ${dir}: ${message}`);
      }
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
      if (isKernelWatchCapacityError(err)) {
        // Capacity exhaustion also defeats chokidar's per-file watches;
        // degrade to polling instead of fanning out doomed retries.
        this.degradeMemoryWatchToPollingSync(dir, markDirty);
        return;
      }
      this.attachMemoryChokidarFallback(dir, markDirty);
    });
    this.nativeMemoryWatchPairs.push(pair);
    const parentResult = this.attachNativeMemoryParentWatch(
      pair,
      recordedInode,
      markDirty,
      "native",
      () => this.attachNativeMemoryWatchForDir(dir, markDirty),
    );
    if (parentResult === "capacity") {
      // Parent creation hit capacity exhaustion: root replacement would stay
      // uncovered. Close the fresh pair and report capacity upward — both
      // callers (startup setup and the replacement callback) own the single
      // degradation, so it is recorded exactly once.
      this.closeNativeMemoryWatchPair(pair);
      return "capacity";
    }
    return "attached";
  }

  private attachNativeMemoryParentWatch(
    pair: NativeMemoryWatchPair,
    recordedInode: number,
    markDirty: (watchPath?: string, stats?: MemoryWatchEventStats) => void,
    label: "native" | "Linux",
    reattach: () => NativeMemoryWatchResult,
  ): NativeMemoryWatchResult {
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
          if (result === "capacity") {
            // Reattachment hit kernel watch exhaustion: chokidar would fail
            // identically, so the directory degrades to polling instead.
            this.degradeMemoryWatchToPollingSync(dir, markDirty);
            return;
          }
          if (result === "failed") {
            this.attachMemoryChokidarFallback(dir, markDirty);
          } else if (result === "attached") {
            // Watch coverage is back for this root; interval ticks stay
            // forced only while other degraded roots remain.
            this.capacityDegradedDirs.delete(pair.dir);
          }
        },
      );
      const attachedParent = parentWatcher;
      attachedParent.on("error", (err) => {
        if (pair.parent !== attachedParent) {
          return;
        }
        const message = err instanceof Error ? err.message : String(err);
        // Capacity exhaustion reports once through the degrade warning.
        if (!isKernelWatchCapacityError(err)) {
          log.warn(`memory ${label} parent watcher error on ${path.dirname(dir)}: ${message}`);
        }
        try {
          attachedParent.close();
        } catch {
          // ignore
        }
        pair.parent = null;
        if (isKernelWatchCapacityError(err)) {
          // Even with a live main watcher, the kernel can no longer grant the
          // parent watch, so root replacement would go undetected — and a
          // retry would hit the same limit. Degrade the whole tree to forced
          // polling instead of running blind on the parent.
          this.closeNativeMemoryWatchPair(pair);
          if (!this.closed) {
            this.degradeMemoryWatchToPollingSync(dir, markDirty);
          }
          return;
        }
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
      return "attached";
    } catch (err) {
      if (isKernelWatchCapacityError(err)) {
        // The kernel cannot grant the parent watch even at creation time.
        // Signal the caller instead of degrading here: during a reattach the
        // caller must keep the (still-armed) polling state, and closing the
        // freshly attached pair is the caller's bookkeeping.
        return "capacity";
      }
      // Parent watcher couldn't start (e.g. parentDir not accessible).
      // The main watcher still works for non-replacement events; just
      // log and continue.
      log.warn(
        `memory ${label} parent watcher could not start on ${path.dirname(dir)}: ${String(err)}`,
      );
      return "attached";
    }
  }

  // Linux inotify has no native recursive primitive, so the tree algorithm
  // (per-directory watchers + on-demand subtree attach + parent reattach)
  // lives in manager-watch-linux.ts; this wrapper feeds it the manager-owned
  // bookkeeping, fallbacks, and capacity degradation.
  protected attachLinuxMemoryDirectoryTreeWatchForDir(
    dir: string,
    markDirty: (watchPath?: string, stats?: MemoryWatchEventStats) => void,
  ): NativeMemoryWatchResult {
    return attachLinuxMemoryDirectoryTreeWatchForDir(
      this.resolveLinuxWatchAttachContext(),
      dir,
      markDirty,
    );
  }

  private resolveLinuxWatchAttachContext(): MemoryWatchAttachContext {
    return {
      closed: () => this.closed,
      multimodalSettings: this.settings.multimodal,
      createNativeWatch: resolveMemoryNativeWatchFactory(),
      registerPair: (pair) => {
        this.nativeMemoryWatchPairs.push(pair);
      },
      closePair: (pair) => {
        this.closeNativeMemoryWatchPair(pair);
      },
      onCapacityExhausted: (degradedDir, markDirty) => {
        this.degradeMemoryWatchToPollingSync(degradedDir, markDirty);
      },
      chokidarFallback: (fallbackDir, markDirty) => {
        this.attachMemoryChokidarFallback(fallbackDir, markDirty);
      },
      attachParentWatch: (pair, recordedInode, markDirty, reattach) =>
        this.attachNativeMemoryParentWatch(pair, recordedInode, markDirty, "Linux", reattach),
    };
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

  /**
   * Degrades a capacity-exhausted directory to interval-sync refreshing: one
   * warn, an immediate dirty sync, and a guaranteed interval timer (honoring a
   * configured intervalMinutes, otherwise the fallback cadence). While active,
   * every interval tick forces a rescan because no watcher remains to mark
   * the index dirty on file changes.
   */
  private degradeMemoryWatchToPollingSync(
    dir: string,
    markDirty: (watchPath?: string, stats?: MemoryWatchEventStats) => void,
  ): void {
    log.warn(
      `kernel watch capacity exhausted on ${dir}; skipping chokidar fallback and degrading memory index to interval sync`,
    );
    this.capacityDegradedDirs.add(dir);
    if (!this.closed) {
      markDirty();
    }
    this.ensureIntervalSync(MEMORY_WATCH_CAPACITY_FALLBACK_INTERVAL_MINUTES);
  }

  protected ensureIntervalSync(fallbackMinutes = 0): void {
    const configured = this.settings.sync.intervalMinutes;
    const minutes = configured > 0 ? configured : fallbackMinutes;
    if (!minutes || minutes <= 0 || this.intervalTimer) {
      return;
    }
    const ms = resolveTimerTimeoutMs(minutes * 60 * 1000, 0, 0);
    if (ms <= 0) {
      return;
    }
    this.intervalTimer = setInterval(() => {
      if (this.capacityDegradedDirs.size > 0) {
        // Degraded polling has no watcher to re-dirty the index, so every
        // tick must rescan; otherwise the first successful sync clears the
        // dirty flag and later edits are never picked up.
        this.dirty = true;
      }
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
