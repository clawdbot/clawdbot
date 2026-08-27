/**
 * Per-file mutation queue.
 *
 * Serializes edits/writes targeting the same real file while allowing independent files to mutate in parallel.
 */
import { resolveIdentityPathViaExistingAncestorSync } from "../../../infra/boundary-path.js";
import { resolveGlobalMap } from "../../../shared/global-singleton.js";

const fileMutationTails = resolveGlobalMap<string, Promise<void>>(
  Symbol.for("openclaw.fileMutationTails"),
  "close-only",
);

function resolveLocalFileMutationQueueKey(filePath: string): string {
  return resolveIdentityPathViaExistingAncestorSync(filePath);
}

export async function resolveFileMutationQueueKey(
  filePath: string,
  resolveQueueKey?: (absolutePath: string) => string | Promise<string>,
): Promise<string> {
  return await (resolveQueueKey?.(filePath) ?? resolveLocalFileMutationQueueKey(filePath));
}

/**
 * Serialize file mutation operations targeting the same file.
 * Operations for different files still run in parallel.
 */
export async function withFileMutationQueue<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  return await withFileMutationQueues([filePath], fn);
}

export async function withFileMutationQueueKey<T>(key: string, fn: () => Promise<T>): Promise<T> {
  return await withFileMutationQueueKeys([key], fn);
}

async function withFileMutationQueues<T>(
  filePaths: readonly string[],
  fn: () => Promise<T>,
): Promise<T> {
  return await withFileMutationQueueKeys(filePaths.map(resolveLocalFileMutationQueueKey), fn);
}

export async function withFileMutationQueueKeys<T>(
  queueKeys: readonly string[],
  fn: () => Promise<T>,
): Promise<T> {
  const keys = [...new Set(queueKeys)].toSorted();
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
