import fs, { type FSWatcher } from "node:fs";
import path from "node:path";

export type DirtyDirectoryWatch = {
  /** Direct-child names changed since the previous take, or "all" when coverage is uncertain. */
  takeDirty(): "all" | Set<string>;
  /** Linux only: maintain one non-recursive watcher per named child directory. */
  observeChildDirectories(names: Iterable<string>): void;
  close(): void;
};

const WATCH_RETRY_MS = 5_000;
// macOS creates the FSEvents stream asynchronously after fs.watch() returns, so writes landing
// before it is live are never reported. A watch vouches for coverage only once it has been
// attached this long and polled; the caller's full read on that poll closes the gap.
const WATCH_ARM_MS = 250;

export function createDirtyDirectoryWatch(root: string): DirtyDirectoryWatch {
  const recursive = process.platform === "darwin" || process.platform === "win32";
  const children = new Map<string, FSWatcher>();
  let rootWatch: FSWatcher | undefined;
  let dirty: "all" | Set<string> = new Set();
  let retryAt = 0;
  let attachedAt = 0;
  let armed = false;
  let closed = false;
  const closeWatchers = () => {
    rootWatch?.close();
    rootWatch = undefined;
    for (const watcher of children.values()) {
      watcher.close();
    }
    children.clear();
  };
  const fail = () => {
    closeWatchers();
    dirty = "all";
    retryAt = Date.now() + WATCH_RETRY_MS;
  };
  const attach = (child?: string): FSWatcher | undefined => {
    try {
      if (!recursive && process.platform !== "linux") {
        fail();
        return undefined;
      }
      // Linux recursive fs.watch uses internal/fs/recursive_watch and watches every file.
      // Root + immediate-directory watches avoid fan-out into the much larger transcript trees.
      return fs
        .watch(
          child ? path.join(root, child) : root,
          { recursive, persistent: false },
          (event, filename) => {
            const name = child ?? filename?.split(/[\\/]/, 1)[0];
            if (!name || (!child && event === "rename" && filename === path.basename(root))) {
              dirty = "all";
            } else if (dirty !== "all") {
              dirty.add(name);
            }
            if (!child && event === "rename" && name) {
              children.get(name)?.close();
              children.delete(name);
            }
          },
        )
        .on("error", fail);
    } catch (error) {
      const code = error && typeof error === "object" && "code" in error ? error.code : undefined;
      if (child && (code === "ENOENT" || code === "ENOTDIR")) {
        return undefined;
      }
      fail();
      return undefined;
    }
  };
  const attachRoot = () => {
    rootWatch = attach();
    attachedAt = performance.now();
    armed = false;
    dirty = rootWatch ? new Set() : "all";
  };
  attachRoot();
  return {
    takeDirty() {
      if (closed || !rootWatch) {
        if (!closed && Date.now() >= retryAt) {
          attachRoot();
        }
        return "all";
      }
      if (!armed) {
        armed = performance.now() - attachedAt >= WATCH_ARM_MS;
        return "all";
      }
      const result = dirty;
      if (result === "all") {
        // Unknown coverage may mean the watched inode was replaced; re-arm before the full read.
        closeWatchers();
        attachRoot();
      } else {
        dirty = new Set();
      }
      return result;
    },
    observeChildDirectories(names) {
      if (recursive || closed || !rootWatch) {
        return;
      }
      const wanted = new Set(names);
      for (const [name, watcher] of children) {
        if (!wanted.has(name)) {
          watcher.close();
          children.delete(name);
        }
      }
      for (const name of wanted) {
        if (!children.has(name)) {
          const watcher = attach(name);
          if (!rootWatch) {
            break;
          }
          if (watcher) {
            children.set(name, watcher);
          }
        }
      }
    },
    close() {
      closed = true;
      closeWatchers();
    },
  };
}
