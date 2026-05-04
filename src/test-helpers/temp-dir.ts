import fsSync from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

type PrefixRootState = {
  path: string;
  activeCount: number;
};

const asyncPrefixRoots = new Map<string, PrefixRootState>();
const pendingAsyncPrefixRoots = new Map<string, Promise<PrefixRootState>>();
const syncPrefixRoots = new Map<string, PrefixRootState>();
let nextAsyncDirIndex = 0;
let nextSyncDirIndex = 0;

function getRootKey(options: { prefix: string; parentDir?: string }): string {
  return `${options.parentDir ?? os.tmpdir()}\u0000${options.prefix}`;
}

async function acquireAsyncPrefixRoot(options: {
  prefix: string;
  parentDir?: string;
}): Promise<PrefixRootState> {
  const key = getRootKey(options);
  const cached = asyncPrefixRoots.get(key);
  if (cached) {
    cached.activeCount += 1;
    return cached;
  }
  const pending = pendingAsyncPrefixRoots.get(key);
  if (pending) {
    const state = await pending;
    state.activeCount += 1;
    return state;
  }
  const create = fs
    .mkdtemp(path.join(options.parentDir ?? os.tmpdir(), options.prefix))
    .then((root) => ({ path: root, activeCount: 0 }));
  pendingAsyncPrefixRoots.set(key, create);
  try {
    const state = await create;
    asyncPrefixRoots.set(key, state);
    state.activeCount += 1;
    return state;
  } finally {
    pendingAsyncPrefixRoots.delete(key);
  }
}

function acquireSyncPrefixRoot(options: { prefix: string; parentDir?: string }): PrefixRootState {
  const key = getRootKey(options);
  const cached = syncPrefixRoots.get(key);
  if (cached) {
    cached.activeCount += 1;
    return cached;
  }
  const root = fsSync.mkdtempSync(path.join(options.parentDir ?? os.tmpdir(), options.prefix));
  const state = { path: root, activeCount: 1 };
  syncPrefixRoots.set(key, state);
  return state;
}

async function releaseAsyncPrefixRoot(options: {
  prefix: string;
  parentDir?: string;
}): Promise<void> {
  const key = getRootKey(options);
  const state = asyncPrefixRoots.get(key);
  if (!state) {
    return;
  }
  state.activeCount -= 1;
  if (state.activeCount > 0) {
    return;
  }
  asyncPrefixRoots.delete(key);
  await fs.rm(state.path, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 25,
  });
}

function releaseSyncPrefixRoot(options: { prefix: string; parentDir?: string }) {
  const key = getRootKey(options);
  const state = syncPrefixRoots.get(key);
  if (!state) {
    return;
  }
  state.activeCount -= 1;
  if (state.activeCount > 0) {
    return;
  }
  syncPrefixRoots.delete(key);
  fsSync.rmSync(state.path, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 25,
  });
}

export async function withTempDir<T>(
  options: {
    prefix: string;
    parentDir?: string;
    subdir?: string;
  },
  run: (dir: string) => Promise<T>,
): Promise<T> {
  const root = await acquireAsyncPrefixRoot(options);
  const base = path.join(root.path, `dir-${String(nextAsyncDirIndex)}`);
  nextAsyncDirIndex += 1;
  try {
    await fs.mkdir(base, { recursive: true });
    const dir = options.subdir ? path.join(base, options.subdir) : base;
    if (options.subdir) {
      await fs.mkdir(dir, { recursive: true });
    }
    return await run(dir);
  } finally {
    await fs.rm(base, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 25,
    });
    await releaseAsyncPrefixRoot(options);
  }
}

export function createSuiteTempRootTracker(options: { prefix: string; parentDir?: string }) {
  let root = "";
  let nextIndex = 0;

  return {
    async setup(): Promise<string> {
      root = await fs.mkdtemp(path.join(options.parentDir ?? os.tmpdir(), options.prefix));
      nextIndex = 0;
      return root;
    },
    async make(prefix = "case"): Promise<string> {
      const dir = path.join(root, `${prefix}-${nextIndex++}`);
      await fs.mkdir(dir, { recursive: true });
      return dir;
    },
    async cleanup(): Promise<void> {
      if (!root) {
        return;
      }
      const currentRoot = root;
      root = "";
      nextIndex = 0;
      await fs.rm(currentRoot, {
        recursive: true,
        force: true,
        maxRetries: 20,
        retryDelay: 25,
      });
    },
  };
}

export function withTempDirSync<T>(
  options: {
    prefix: string;
    parentDir?: string;
    subdir?: string;
  },
  run: (dir: string) => T,
): T {
  const root = acquireSyncPrefixRoot(options);
  const base = path.join(root.path, `dir-${String(nextSyncDirIndex)}`);
  nextSyncDirIndex += 1;
  try {
    fsSync.mkdirSync(base, { recursive: true });
    const dir = options.subdir ? path.join(base, options.subdir) : base;
    if (options.subdir) {
      fsSync.mkdirSync(dir, { recursive: true });
    }
    return run(dir);
  } finally {
    fsSync.rmSync(base, {
      recursive: true,
      force: true,
      maxRetries: 20,
      retryDelay: 25,
    });
    releaseSyncPrefixRoot(options);
  }
}
