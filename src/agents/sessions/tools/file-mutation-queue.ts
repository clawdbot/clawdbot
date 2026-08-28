import { getAgentToolExecutionContext } from "../../../../packages/agent-core/src/tool-execution-context.js";
/**
 * Per-file mutation queue.
 *
 * Serializes reads and mutations targeting the same real file while allowing independent files to run in parallel.
 */
import { resolveIdentityPathViaExistingAncestorSync } from "../../../infra/boundary-path.js";
import { resolveGlobalMap, resolveGlobalSingleton } from "../../../shared/global-singleton.js";

const fileMutationTails = resolveGlobalMap<string, Promise<void>>(
  Symbol.for("openclaw.fileMutationTails"),
  "close-only",
);
const keyAdmissions = resolveGlobalSingleton(
  Symbol.for("openclaw.fileMutationKeyAdmissions"),
  () => ({ fallbackScope: {}, tails: new WeakMap<object, Promise<void>>() }),
);

function resolveLocalFileMutationQueueKey(filePath: string): string {
  return resolveIdentityPathViaExistingAncestorSync(filePath);
}

export async function resolveFileMutationQueueKey(
  filePath: string,
  resolveQueueKey?: (absolutePath: string, signal?: AbortSignal) => string | Promise<string>,
  signal?: AbortSignal,
): Promise<string> {
  return await (resolveQueueKey?.(filePath, signal) ?? resolveLocalFileMutationQueueKey(filePath));
}

/**
 * Preserve source-call admission while backend-owned physical identities resolve concurrently.
 * Registration is ordered per assistant message; file operations still use only fileMutationTails.
 */
export async function withFileMutationQueueKeyResolution<T>(
  keyResolution: Promise<string>,
  fn: () => Promise<T>,
): Promise<T> {
  return await withFileMutationQueueKeysResolution(
    keyResolution.then((key) => [key]),
    fn,
  );
}

export async function withFileMutationQueueKeysResolution<T>(
  keysResolution: Promise<readonly string[]>,
  fn: () => Promise<T>,
): Promise<T> {
  const scope = getAgentToolExecutionContext()?.assistantMessage ?? keyAdmissions.fallbackScope;
  const previousAdmission = keyAdmissions.tails.get(scope) ?? Promise.resolve();
  void keysResolution.catch(() => undefined);
  let operation!: Promise<T>;
  const admission = previousAdmission.then(async () => {
    const keys = await keysResolution;
    operation = enqueueFileMutationQueueKeys(keys, fn);
  });
  const tail = admission.then(
    () => undefined,
    () => undefined,
  );
  keyAdmissions.tails.set(scope, tail);
  const cleanup = () => {
    if (keyAdmissions.tails.get(scope) === tail) {
      keyAdmissions.tails.delete(scope);
    }
  };
  tail.then(cleanup, cleanup);
  await admission;
  return await operation;
}

/**
 * Serialize file mutation operations targeting the same file.
 * Operations for different files still run in parallel.
 */
export async function withFileMutationQueue<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  return await withFileMutationQueues([filePath], fn);
}

async function withFileMutationQueues<T>(
  filePaths: readonly string[],
  fn: () => Promise<T>,
): Promise<T> {
  return await enqueueFileMutationQueueKeys(filePaths.map(resolveLocalFileMutationQueueKey), fn);
}

function enqueueFileMutationQueueKeys<T>(
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
  return current;
}
