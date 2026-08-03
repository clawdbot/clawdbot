// Tracks temporary directories created by tests so leaks can be detected.
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";

/** Allocates temp directories under reusable roots with explicit cleanup control. */
export function createTrackedTempDirs() {
  const prefixRoots = new Map<string, { root: string; nextIndex: number }>();
  const pendingPrefixRoots = new Map<string, Promise<{ root: string; nextIndex: number }>>();
  const cleanupRoots = new Set<string>();
  let globalDirIndex = 0;

  const ensurePrefixRoot = async (prefix: string) => {
    const cached = prefixRoots.get(prefix);
    if (cached) {
      return cached;
    }
    const pending = pendingPrefixRoots.get(prefix);
    if (pending) {
      return await pending;
    }
    const create = (async () => {
      const root = await fs.mkdtemp(path.join(os.tmpdir(), prefix));
      const state = { root, nextIndex: 0 };
      prefixRoots.set(prefix, state);
      cleanupRoots.add(root);
      return state;
    })();
    pendingPrefixRoots.set(prefix, create);
    try {
      return await create;
    } finally {
      pendingPrefixRoots.delete(prefix);
    }
  };

  return {
    async make(prefix: string): Promise<string> {
      const state = await ensurePrefixRoot(prefix);
      const dir = path.join(state.root, `dir-${String(globalDirIndex)}`);
      state.nextIndex += 1;
      globalDirIndex += 1;
      await fs.mkdir(dir, { recursive: true });
      return dir;
    },
    async cleanup(): Promise<void> {
      const roots = [...cleanupRoots];
      pendingPrefixRoots.clear();
      const dirlists = await Promise.all(
        roots.map((dir) =>
          fs.readdir(dir).catch((err: unknown) => {
            if ((err as NodeJS.ErrnoException).code === "ENOENT") {
              return [];
            }
            throw err;
          }),
        ),
      );
      await Promise.all(
        roots.flatMap((dir, i) =>
          expectDefined(dirlists[i], "dirlists entry at i").map((entry) =>
            fs.rm(path.join(dir, entry), { recursive: true, force: true }),
          ),
        ),
      );
      for (const dir of roots) {
        for (const state of prefixRoots.values()) {
          if (state.root === dir) {
            state.nextIndex = 0;
          }
        }
      }
    },
  };
}
