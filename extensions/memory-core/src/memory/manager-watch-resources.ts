// Memory Core owns memory watcher resources and their degraded lifecycle.
import fsSync from "node:fs";
import { getFileWatchCapacityCode } from "openclaw/plugin-sdk/file-access-runtime";
import { createSubsystemLogger } from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { formatCliCommand } from "openclaw/plugin-sdk/setup-tools";
import { MemoryManagerSyncBase } from "./manager-sync-base.js";
import {
  countChokidarWatchedEntries,
  type MemoryWatchPressureUnit,
  type MemoryWatchPressureWarningState,
  warnIfMemoryWatchPressureHigh,
} from "./watch-pressure.js";

const MEMORY_WATCH_PRESSURE_STARTUP_CHECK_DELAY_MS = 10_000;
const log = createSubsystemLogger("memory");

export type NativeMemoryWatchPair = {
  dir: string;
  main: fsSync.FSWatcher | null;
  parent: fsSync.FSWatcher | null;
  treeWatchers?: Map<string, LinuxMemoryDirectoryWatcher>;
};

export type LinuxMemoryDirectoryWatcher = {
  watcher: fsSync.FSWatcher;
  ino: number;
};

export abstract class MemoryManagerWatchResources extends MemoryManagerSyncBase {
  protected readonly nativeMemoryWatchPairs: NativeMemoryWatchPair[] = [];
  private readonly memoryWatchPressureWarning: MemoryWatchPressureWarningState = { shown: false };
  protected memoryWatchCapacityDegraded = false;

  protected scheduleMemoryWatchPressureStartupCheck(): void {
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

  protected warnIfMemoryWatchPressure(count: number, unit: MemoryWatchPressureUnit): void {
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

  protected closeNativeMemoryWatchChildren(pair: NativeMemoryWatchPair): void {
    if (pair.treeWatchers) {
      for (const entry of pair.treeWatchers.values()) {
        try {
          entry.watcher.close();
        } catch {
          // ignore close failures
        }
      }
      pair.treeWatchers.clear();
    } else if (pair.main) {
      try {
        pair.main.close();
      } catch {
        // ignore close failures
      }
    }
    pair.main = null;
  }

  protected closeNativeMemoryWatchPair(pair: NativeMemoryWatchPair): void {
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

  // Watcher create/error only. Scan-side codes (readdir/lstat/stat ENOSPC)
  // can mean a full disk, not an exhausted watch table; those callers keep
  // closeAndFallback so watching can resume after the host recovers.
  protected degradeMemoryWatchCapacity(
    watchPath: string,
    err: unknown,
    markDirty: () => void,
  ): boolean {
    const code = getFileWatchCapacityCode(err);
    if (!code) {
      return false;
    }
    if (this.memoryWatchCapacityDegraded) {
      return true;
    }
    this.memoryWatchCapacityDegraded = true;
    this.closeNativeMemoryWatchPairs();
    const watcher = this.watcher;
    if (watcher) {
      void watcher.close().catch((error: unknown) => {
        log.warn(`memory watcher close failed: ${String(error)}`);
      });
      // Chokidar removes error listeners before pending filesystem operations settle.
      watcher.on("error", () => {});
    }
    markDirty();
    log.warn(
      `memory watcher capacity exhausted on ${watchPath} (${code}); ` +
        "watching disabled, memory will refresh on search",
    );
    return true;
  }

  private removeNativeMemoryWatchPair(pair: NativeMemoryWatchPair): void {
    const idx = this.nativeMemoryWatchPairs.indexOf(pair);
    if (idx >= 0) {
      this.nativeMemoryWatchPairs.splice(idx, 1);
    }
  }
}
