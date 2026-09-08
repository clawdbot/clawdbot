import { EventEmitter } from "node:events";
import path from "node:path";
import { expect, vi } from "vitest";

type WatchEvent = "add" | "addDir" | "all" | "change" | "unlink" | "unlinkDir" | "raw" | "error";
type WatchCallback = (...args: unknown[]) => void;
type WatchOptions = {
  depth: number;
  followSymlinks: boolean;
  usePolling: boolean;
  ignored: (
    watchPath: string,
    stats?: { isDirectory?: () => boolean; isSymbolicLink?: () => boolean },
  ) => boolean;
};

function createMockWatcher() {
  const events = new EventEmitter();
  const watcher = {
    closed: false,
    on: vi.fn((event: WatchEvent, callback: WatchCallback) => {
      events.on(event, callback);
      return watcher;
    }),
    close: vi.fn(async () => {
      if (watcher.closed) {
        return;
      }
      watcher.closed = true;
      events.removeAllListeners();
    }),
    emit: (event: WatchEvent, ...args: unknown[]) => {
      events.emit(event, ...args);
    },
  };
  return watcher;
}

export function createSkillsWatcherMock() {
  const createdWatchers: Array<ReturnType<typeof createMockWatcher>> = [];
  const watchMock = vi.fn((_watchRoot: string, _options: WatchOptions) => {
    const watcher = createMockWatcher();
    createdWatchers.push(watcher);
    return watcher;
  });
  function watchForSkillRoot(root: string) {
    // Distinguish logical subscriptions that share one physical ancestor by
    // their public traversal filter, rather than depending on watcher order.
    const index = watchMock.mock.calls.findLastIndex(
      ([, options]) =>
        !options.ignored(path.join(root, "SKILL.md")) &&
        options.ignored(path.join(path.dirname(root), "SKILL.md")),
    );
    expect(index, `watch subscription for ${root}`).toBeGreaterThanOrEqual(0);
    const [watchRoot, options] = watchMock.mock.calls[index]!;
    return { watchRoot, options, watcher: createdWatchers[index]! };
  }

  return { createdWatchers, watchMock, watchForSkillRoot };
}
