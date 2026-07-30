/**
 * Per-file mutation queue.
 *
 * Serializes edits/writes targeting the same real file while allowing independent files to mutate in parallel.
 */
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

const fileMutationTails = new Map<string, Promise<void>>();

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
  return await withFileMutationQueues([filePath], fn);
}

export async function withFileMutationQueues<T>(
  filePaths: readonly string[],
  fn: () => Promise<T>,
): Promise<T> {
  const keys = [...new Set(filePaths.map(getMutationQueueKey))].toSorted();
  const current = Promise.all(
    keys.map((key) => (fileMutationTails.get(key) ?? Promise.resolve()).catch(() => undefined)),
  ).then(fn);
  const tail = current.then(
    () => undefined,
    () => undefined,
  );
  for (const key of keys) {
    fileMutationTails.set(key, tail);
  }
  const cleanup = () => {
    for (const key of keys) {
      if (fileMutationTails.get(key) === tail) {
        fileMutationTails.delete(key);
      }
    }
  };
  tail.then(cleanup, cleanup);
  return await current;
}
