/**
 * Per-file mutation queue.
 *
 * Serializes edits/writes targeting the same real file while allowing independent files to mutate in parallel.
 */
import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { KeyedAsyncQueue } from "../../../plugin-sdk/keyed-async-queue.js";

const fileMutationQueue = new KeyedAsyncQueue();

function getMutationQueueKey(filePath: string): string {
  const resolvedPath = resolve(filePath);
  try {
    return realpathSync.native(resolvedPath);
  } catch {
    return resolvedPath;
  }
}

/**
 * Serialize file mutation operations targeting the same file.
 * Operations for different files still run in parallel.
 */
export async function withFileMutationQueue<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const key = getMutationQueueKey(filePath);
  return await fileMutationQueue.enqueue(key, fn);
}
