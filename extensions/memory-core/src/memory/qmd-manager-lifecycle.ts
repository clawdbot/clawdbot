import path from "node:path";
import chokidar from "chokidar";
import { qmdManagerLog, type ManagedCollection } from "./qmd-manager-base.js";
import { shouldIgnoreMemoryWatchPath } from "./qmd-manager-helpers.js";
import { QmdManagerSync } from "./qmd-manager-sync.js";
import { countChokidarWatchedEntries, warnIfMemoryWatchPressureHigh } from "./watch-pressure.js";
import {
  recordMemoryWatchEventPath,
  settleMemoryWatchEventPaths,
  type MemoryWatchEventStats,
} from "./watch-settle.js";

export abstract class QmdManagerLifecycle extends QmdManagerSync {
  private closePromise: Promise<void> | null = null;

  protected ensureWatcher(): void {
    if (!this.syncSettings?.watch || this.watcher || this.closed) {
      return;
    }
    const watchPaths = new Set<string>();
    const watchRoots = new Set<string>();
    for (const collection of this.qmd.collections) {
      if (collection.kind === "sessions") {
        continue;
      }
      watchRoots.add(path.normalize(collection.path));
      watchPaths.add(this.resolveCollectionWatchPath(collection));
    }
    if (watchPaths.size === 0) {
      return;
    }
    const watchPathList = Array.from(watchPaths);
    const startTime = Date.now();
    qmdManagerLog.info(
      `qmd watcher starting for agent "${this.agentId}" paths=${watchPathList.length}`,
    );
    const watchRootList = Array.from(watchRoots);
    const watcher = chokidar.watch(watchPathList, {
      ignoreInitial: true,
      ignored: (watchPath) => shouldIgnoreMemoryWatchPath(watchPath, watchRootList),
    });
    this.watcher = watcher;
    const markDirty = (watchPath?: string, stats?: MemoryWatchEventStats) => {
      recordMemoryWatchEventPath(this.pendingWatchPaths, watchPath, stats);
      this.dirty = true;
      this.scheduleWatchSync();
    };
    watcher.on("add", markDirty);
    watcher.on("change", markDirty);
    watcher.on("unlink", markDirty);
    watcher.once("ready", () => {
      this.warnIfWatchPressure(countChokidarWatchedEntries(watcher));
      qmdManagerLog.info(
        `qmd watcher ready for agent "${this.agentId}" paths=${watchPathList.length} durationMs=${Date.now() - startTime}`,
      );
    });
  }

  protected warnIfWatchPressure(count: number): void {
    warnIfMemoryWatchPressureHigh(
      this.watchPressureWarning,
      count,
      "paths",
      "Large QMD collections can make OpenClaw run out of file watchers or open files.",
      "Remove large collections, or set memory.search.sync.watch to false and refresh memory manually.",
      (message) => qmdManagerLog.warn(message),
    );
  }

  protected resolveCollectionWatchPath(collection: ManagedCollection): string {
    return path.join(path.normalize(collection.path), collection.pattern);
  }

  protected scheduleWatchSync(): void {
    if (!this.syncSettings?.watch) {
      return;
    }
    if (this.watchTimer) {
      clearTimeout(this.watchTimer);
    }
    this.watchTimer = setTimeout(() => {
      this.watchTimer = null;
      void (async () => {
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
      })().catch((err: unknown) => {
        qmdManagerLog.warn(`qmd watch sync failed: ${String(err)}`);
      });
    }, this.syncSettings.watchDebounceMs);
  }

  protected async maybeWarmSession(sessionKey?: string): Promise<void> {
    if (this.mode === "cli" || !this.syncSettings?.onSessionStart) {
      return;
    }
    const key = sessionKey?.trim() || "";
    if (!key || this.sessionWarm.has(key)) {
      return;
    }
    this.sessionWarm.add(key);
    void this.sync({ reason: "session-start" }).catch((err: unknown) => {
      qmdManagerLog.warn(`qmd session-start sync failed: ${String(err)}`);
    });
  }

  protected async maybeSyncDirtySearchState(): Promise<void> {
    if (this.mode === "cli" || !this.syncSettings?.onSearch || !this.dirty) {
      return;
    }
    await this.sync({ reason: "search" });
  }

  async close(): Promise<void> {
    const existingClose = this.closePromise;
    if (existingClose) {
      await existingClose;
      return;
    }
    const closeOperation = this.closeOnce();
    this.closePromise = closeOperation;
    try {
      await closeOperation;
    } catch (err) {
      if (this.closePromise === closeOperation) {
        this.closePromise = null;
      }
      throw err;
    }
  }

  private async closeOnce(): Promise<void> {
    this.closed = true;
    this.resolveCloseSignal();
    this.closeAbortController.abort(new Error("qmd manager closed"));
    if (this.updateTimer) {
      clearInterval(this.updateTimer);
      this.updateTimer = null;
    }
    if (this.embedTimer) {
      clearTimeout(this.embedTimer);
      this.embedTimer = null;
    }
    if (this.watchTimer) {
      clearTimeout(this.watchTimer);
      this.watchTimer = null;
    }
    if (this.watcher) {
      await this.watcher.close().catch(() => undefined);
      this.watcher = null;
    }
    this.queuedForcedRuns = 0;
    await this.pendingUpdate?.catch(() => undefined);
    await this.queuedForcedUpdate?.catch(() => undefined);
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}
