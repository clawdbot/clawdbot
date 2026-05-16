import fsSync from "node:fs";
import path from "node:path";

export type MemoryWatchEventStats = {
  isDirectory?: () => boolean;
  size?: number;
  mtimeMs?: number;
};

type WatchPathSnapshot = {
  size: number;
  mtimeMs: number;
};

export type MemoryWatchSettleQueue = Map<string, WatchPathSnapshot | null>;

const MEMORY_WATCH_SETTLE_RECHECK_MS = 100;

function snapshotFromStats(stats?: MemoryWatchEventStats): WatchPathSnapshot | null {
  if (!stats || stats.isDirectory?.()) {
    return null;
  }
  if (typeof stats.size !== "number" || typeof stats.mtimeMs !== "number") {
    return null;
  }
  return { size: stats.size, mtimeMs: stats.mtimeMs };
}

function snapshotsMatch(left: WatchPathSnapshot | null, right: WatchPathSnapshot | null): boolean {
  if (left === null || right === null) {
    return left === right;
  }
  return left.size === right.size && left.mtimeMs === right.mtimeMs;
}

function snapshotPath(filePath: string): WatchPathSnapshot | null {
  try {
    const stats = fsSync.statSync(filePath);
    if (stats.isDirectory()) {
      return null;
    }
    return { size: stats.size, mtimeMs: stats.mtimeMs };
  } catch {
    return null;
  }
}

async function delay(ms: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function recordMemoryWatchEventPath(
  queue: MemoryWatchSettleQueue,
  watchPath?: string,
  stats?: MemoryWatchEventStats,
): void {
  if (!watchPath) {
    return;
  }
  const trimmed = watchPath.trim();
  if (!trimmed) {
    return;
  }
  queue.set(path.resolve(trimmed), snapshotFromStats(stats));
}

export async function settleMemoryWatchEventPaths(queue: MemoryWatchSettleQueue): Promise<boolean> {
  if (queue.size === 0) {
    return true;
  }

  const entries = Array.from(queue.entries());
  queue.clear();
  const missingBaseline: Array<{ filePath: string; snapshot: WatchPathSnapshot }> = [];

  for (const [filePath, previousSnapshot] of entries) {
    const currentSnapshot = snapshotPath(filePath);
    if (previousSnapshot === null) {
      if (currentSnapshot !== null) {
        missingBaseline.push({ filePath, snapshot: currentSnapshot });
      }
      continue;
    }
    if (!snapshotsMatch(previousSnapshot, currentSnapshot)) {
      queue.set(filePath, currentSnapshot);
    }
  }

  if (missingBaseline.length > 0) {
    await delay(MEMORY_WATCH_SETTLE_RECHECK_MS);
    for (const entry of missingBaseline) {
      const currentSnapshot = snapshotPath(entry.filePath);
      if (!snapshotsMatch(entry.snapshot, currentSnapshot)) {
        queue.set(entry.filePath, currentSnapshot);
      }
    }
  }

  return queue.size === 0;
}
