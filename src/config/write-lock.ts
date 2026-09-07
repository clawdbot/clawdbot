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

type LockScope = {
  active: boolean;
  accepting: boolean;
  pending: Set<Promise<unknown>>;
  assertCurrent?: () => void;
};
const activeConfigMutationLocks = new AsyncLocalStorage<{
  paths: Map<string, LockScope>;
  current: LockScope;
}>();
const configMutationQueue = new KeyedAsyncQueue();

/** Capture the live source owner, not merely the fact that a lock was once held. */
export function captureConfigWriteLockGuard(pathname: string): (() => void) | undefined {
  const context = activeConfigMutationLocks.getStore();
  const guarded = [...new Set(context?.paths.values())].filter((scope) => scope.assertCurrent);
  if (!guarded.length) {
    return undefined;
  }
  const target = context?.paths.get(path.resolve(pathname));
  return () => {
    if (!target?.active || !target.assertCurrent) {
      throw new Error("Config write has no live source ownership for this path.");
    }
    for (const scope of guarded) {
      if (!scope.active) {
        throw new Error("Config write source ownership has closed.");
      }
      scope.assertCurrent?.();
    }
  };
}

async function runConfigLockScope<T>(
  configPath: string,
  fn: () => Promise<T>,
  assertCurrent?: () => void,
): Promise<T> {
  const scope: LockScope = { active: true, accepting: true, pending: new Set(), assertCurrent };
  const paths = new Map(activeConfigMutationLocks.getStore()?.paths);
  paths.set(configPath, scope);
  try {
    return await activeConfigMutationLocks.run({ paths, current: scope }, async () => {
      try {
        assertCurrent?.();
        return await fn();
      } finally {
        scope.accepting = false;
        // Admitted writes retain their source lock until settlement, including
        // detached children. The captured guard still checks the real executor.
        while (scope.pending.size > 0) {
          await Promise.allSettled(scope.pending);
        }
      }
    });
  } finally {
    scope.active = false;
  }
}

export async function withConfigWriteLock<T>(
  pathname: string,
  fn: () => Promise<T>,
  env?: NodeJS.ProcessEnv,
  assertCurrent?: () => void,
): Promise<T> {
  const configPath = path.resolve(pathname);
  assertConfigWriteAllowedInCurrentMode({ configPath, env });
  const inherited = activeConfigMutationLocks.getStore();
  const guardedParent = [...(inherited?.paths.entries() ?? [])].find(
    ([, scope]) => scope.assertCurrent,
  );
  const parentGuard = guardedParent ? captureConfigWriteLockGuard(guardedParent[0]) : undefined;
  if (parentGuard && !inherited?.current.accepting) {
    throw new Error("Config write source admission has closed.");
  }
  const guard = assertCurrent
    ? () => {
        parentGuard?.();
        assertCurrent();
      }
    : captureConfigWriteLockGuard(configPath);
  guard?.();
  const inheritedScope = inherited?.paths.get(configPath);
  if (inheritedScope?.active) {
    const running = Promise.resolve().then(() => {
      captureConfigWriteLockGuard(configPath)?.();
      return guard ? runConfigLockScope(configPath, fn, guard) : fn();
    });
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
      return await withFileLock(configPath, CONFIG_MUTATION_LOCK_OPTIONS, () =>
        runConfigLockScope(configPath, fn, guard),
      );
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
  captureConfigWriteLockGuard(configPath)?.();
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
