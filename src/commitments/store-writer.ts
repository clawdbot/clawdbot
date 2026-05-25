// Per-store-path mutation gate for the commitments store. Mirrors the
// in-process queue + cross-process file-lock pattern in
// src/plugin-sdk/persistent-dedupe.ts (issue #81145).

import fs from "node:fs/promises";
import path from "node:path";
import { type FileLockOptions, withFileLock } from "../plugin-sdk/file-lock.js";

type CommitmentsStoreWriterTask = {
  fn: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
};

type CommitmentsStoreWriterQueue = {
  running: boolean;
  pending: CommitmentsStoreWriterTask[];
  drainPromise: Promise<void> | null;
};

const WRITER_QUEUES = new Map<string, CommitmentsStoreWriterQueue>();

// Matches src/plugin-sdk/persistent-dedupe.ts so both lock-protected stores share tuning.
const DEFAULT_COMMITMENTS_LOCK_OPTIONS: FileLockOptions = {
  retries: {
    retries: 6,
    factor: 1.35,
    minTimeout: 8,
    maxTimeout: 180,
    randomize: true,
  },
  stale: 60_000,
};

function getOrCreateWriterQueue(storePath: string): CommitmentsStoreWriterQueue {
  const existing = WRITER_QUEUES.get(storePath);
  if (existing) {
    return existing;
  }
  const created: CommitmentsStoreWriterQueue = {
    running: false,
    pending: [],
    drainPromise: null,
  };
  WRITER_QUEUES.set(storePath, created);
  return created;
}

async function drainCommitmentsStoreWriterQueue(storePath: string): Promise<void> {
  const queue = WRITER_QUEUES.get(storePath);
  if (!queue) {
    return;
  }
  if (queue.drainPromise) {
    await queue.drainPromise;
    return;
  }
  queue.running = true;
  queue.drainPromise = (async () => {
    try {
      while (queue.pending.length > 0) {
        const task = queue.pending.shift();
        if (!task) {
          continue;
        }
        let result: unknown;
        let failed: unknown;
        let hasFailure = false;
        try {
          result = await task.fn();
        } catch (err) {
          hasFailure = true;
          failed = err;
        }
        if (hasFailure) {
          task.reject(failed);
          continue;
        }
        task.resolve(result);
      }
    } finally {
      queue.running = false;
      queue.drainPromise = null;
      if (queue.pending.length === 0) {
        WRITER_QUEUES.delete(storePath);
      } else {
        queueMicrotask(() => {
          void drainCommitmentsStoreWriterQueue(storePath);
        });
      }
    }
  })();
  await queue.drainPromise;
}

// The advisory lockfile lives next to the data file; create the parent dir up
// front so acquireFileLock does not ENOENT before the user fn ever runs.
async function ensureCommitmentsStoreDir(storePath: string): Promise<void> {
  await fs.mkdir(path.dirname(storePath), { recursive: true });
}

export async function runExclusiveCommitmentsStoreWrite<T>(
  storePath: string,
  fn: () => Promise<T>,
): Promise<T> {
  if (!storePath || typeof storePath !== "string") {
    throw new Error(
      `runExclusiveCommitmentsStoreWrite: storePath must be a non-empty string, got ${JSON.stringify(
        storePath,
      )}`,
    );
  }
  const queue = getOrCreateWriterQueue(storePath);
  return await new Promise<T>((resolve, reject) => {
    const task: CommitmentsStoreWriterTask = {
      fn: async () => {
        await ensureCommitmentsStoreDir(storePath);
        return await withFileLock(storePath, DEFAULT_COMMITMENTS_LOCK_OPTIONS, fn);
      },
      resolve: (value) => resolve(value as T),
      reject,
    };
    queue.pending.push(task);
    void drainCommitmentsStoreWriterQueue(storePath);
  });
}

export function clearCommitmentsStoreWriterQueuesForTest(): void {
  for (const queue of WRITER_QUEUES.values()) {
    for (const task of queue.pending) {
      task.reject(new Error("commitments store writer queue cleared for test"));
    }
  }
  WRITER_QUEUES.clear();
}
