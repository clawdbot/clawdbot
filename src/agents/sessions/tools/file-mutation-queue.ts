/**
 * Per-file mutation queue.
 *
 * Serializes edits/writes targeting the same real file while allowing independent files to mutate in parallel.
 */
import { realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { hasErrnoCode } from "../../../infra/errors.js";
import { resolveGlobalMap } from "../../../shared/global-singleton.js";

const fileMutationTails = resolveGlobalMap<string, Promise<void>>(
  Symbol.for("openclaw.fileMutationTails"),
  "close-only",
);

function getMutationQueueKey(filePath: string): string {
  const resolvedPath = resolve(filePath);
  const missingSegments: string[] = [];
  let candidate = resolvedPath;
  while (true) {
    try {
      return resolve(realpathSync.native(candidate), ...missingSegments.toReversed());
    } catch (error) {
      const parent = dirname(candidate);
      if (!hasErrnoCode(error, "ENOENT") || parent === candidate) {
        return resolvedPath;
      }
      missingSegments.push(basename(candidate));
      candidate = parent;
    }
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
