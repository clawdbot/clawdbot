// Per-store-path mutation gate for the commitments store. Mirrors the
// in-process queue + cross-process file-lock pattern in
// src/plugin-sdk/persistent-dedupe.ts (issue #81145).

import fs from "node:fs/promises";
import path from "node:path";
import { type FileLockOptions, withFileLock } from "../plugin-sdk/file-lock.js";
import {
  clearStoreWriterQueuesForTest,
  runQueuedStoreWrite,
  type StoreWriterQueue,
} from "../shared/store-writer-queue.js";

const WRITER_QUEUES = new Map<string, StoreWriterQueue>();

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

// The advisory lockfile lives next to the data file; create the parent dir up
// front so acquireFileLock does not ENOENT before the user fn ever runs.
async function ensureCommitmentsStoreDir(storePath: string): Promise<void> {
  await fs.mkdir(path.dirname(storePath), { recursive: true });
}

export async function runExclusiveCommitmentsStoreWrite<T>(
  storePath: string,
  fn: () => Promise<T>,
): Promise<T> {
  return await runQueuedStoreWrite({
    queues: WRITER_QUEUES,
    storePath,
    label: "runExclusiveCommitmentsStoreWrite",
    fn: async () => {
      await ensureCommitmentsStoreDir(storePath);
      return await withFileLock(storePath, DEFAULT_COMMITMENTS_LOCK_OPTIONS, fn);
    },
  });
}

export function clearCommitmentsStoreWriterQueuesForTest(): void {
  clearStoreWriterQueuesForTest(WRITER_QUEUES, "commitments store writer queue cleared for test");
}
