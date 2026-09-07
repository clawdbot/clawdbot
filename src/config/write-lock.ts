// Shared lock owner for root/include mutation and direct config IO writes.
import { AsyncLocalStorage } from "node:async_hooks";
import fs from "node:fs/promises";
import path from "node:path";
import { formatErrorMessage, isErrno } from "../infra/errors.js";
import { withFileLock } from "../infra/file-lock.js";
import { KeyedAsyncQueue } from "../plugin-sdk/keyed-async-queue.js";
import { assertConfigWriteAllowedInCurrentMode } from "./nix-mode-write-guard.js";

const CONFIG_MUTATION_LOCK_OPTIONS = {
  retries: { retries: 80, factor: 1.2, minTimeout: 25, maxTimeout: 250, randomize: true },
  stale: 30_000,
} as const;

type LockScope = { active: boolean; pending: Set<Promise<unknown>> };
const activeConfigMutationLocks = new AsyncLocalStorage<{
  paths: Map<string, LockScope>;
  current: LockScope;
}>();
const configMutationQueue = new KeyedAsyncQueue();

export async function withConfigWriteLock<T>(
  pathname: string,
  fn: () => Promise<T>,
  env?: NodeJS.ProcessEnv,
): Promise<T> {
  const configPath = path.resolve(pathname);
  assertConfigWriteAllowedInCurrentMode({ configPath, env });
  const inherited = activeConfigMutationLocks.getStore();
  const inheritedScope = inherited?.paths.get(configPath);
  if (inheritedScope?.active) {
    const running = Promise.resolve().then(fn);
    inheritedScope.pending.add(running);
    try {
      return await running;
    } finally {
      inheritedScope.pending.delete(running);
    }
  }
  const configDir = path.dirname(configPath);
  await fs.mkdir(configDir, { recursive: true, mode: 0o700 });
  return await configMutationQueue
    .enqueue(configPath, async () => {
      const scope: LockScope = { active: false, pending: new Set() };
      const paths = new Map(inherited?.paths);
      paths.set(configPath, scope);
      try {
        return await activeConfigMutationLocks.run(
          { paths, current: scope },
          async () =>
            await withFileLock(configPath, CONFIG_MUTATION_LOCK_OPTIONS, async () => {
              scope.active = true;
              try {
                return await fn();
              } finally {
                // Reentrant work may be detached from fn. Keep its actual writes inside
                // the same lock, including children it admits while settling.
                while (scope.pending.size > 0) {
                  await Promise.allSettled(scope.pending);
                }
                scope.active = false;
              }
            }),
        );
      } finally {
        // Detached async work retains its ALS context, but cannot retain a released lock.
        scope.active = false;
      }
    })
    .catch(async (error: unknown) => {
      if (!(await isPermissionErrorInDirectory(error, configDir))) {
        throw error;
      }
      throw new Error(
        `OpenClaw cannot write to the config directory ${configDir}. Fix its ownership or permissions, then try again. Underlying error: ${formatErrorMessage(error)}`,
        { cause: error },
      );
    });
}

export function markActiveConfigMutationPath(configPath: string): void {
  const scope = activeConfigMutationLocks.getStore();
  if (scope?.current.active) {
    scope.paths.set(path.resolve(configPath), scope.current);
  }
}

async function isPermissionErrorInDirectory(error: unknown, directory: string): Promise<boolean> {
  if (
    !isErrno(error) ||
    (error.code !== "EACCES" && error.code !== "EPERM" && error.code !== "EROFS")
  ) {
    return false;
  }
  const failedPath = error.path;
  if (typeof failedPath !== "string") {
    return false;
  }
  const failedDir = path.dirname(path.resolve(failedPath));
  if (failedDir === directory) {
    return true;
  }
  // Node reports the canonical path, so a config directory reached through a symlink (a macOS
  // /var -> /private/var home, for one) never matches the raw string. Resolve only on mismatch to
  // keep the successful write path free of an extra syscall.
  const canonicalDirectory = await fs.realpath(directory).catch(() => undefined);
  return canonicalDirectory !== undefined && failedDir === canonicalDirectory;
}
