// Slack plugin module implements poll sqlite state helpers.
import path from "node:path";
import { withFileLock } from "openclaw/plugin-sdk/file-lock";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
import { getSlackRuntime } from "./runtime.js";

type SlackSqliteStateOptions = {
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  stateDir?: string;
  storePath?: string;
};

function resolveSlackStateDirOverride(
  options: SlackSqliteStateOptions | undefined,
): string | undefined {
  if (!options) {
    return undefined;
  }
  if (options.stateDir) {
    return options.stateDir;
  }
  if (options.storePath) {
    return path.dirname(options.storePath);
  }
  if (options.homedir) {
    return getSlackRuntime().state.resolveStateDir(options.env ?? process.env, options.homedir);
  }
  return options.env?.OPENCLAW_STATE_DIR?.trim() || undefined;
}

export function resolveSlackSqliteStateEnv(
  options: SlackSqliteStateOptions | undefined,
): NodeJS.ProcessEnv | undefined {
  const stateDir = resolveSlackStateDirOverride(options);
  if (!stateDir) {
    return options?.env;
  }
  return {
    ...(options?.env ?? process.env),
    OPENCLAW_STATE_DIR: stateDir,
  };
}

/**
 * Deep-copy through JSON so stored rows never share references with caller
 * objects and never carry prototype pollution from externally-shaped payloads.
 */
export function toPluginJsonValue<T>(value: T): T {
  const serialized = JSON.stringify(value);
  // SAFETY: a same-shape JSON round-trip yields the same type; this deep copy
  return JSON.parse(serialized) as T;
}

function resolveSlackSqliteStateDir(options: SlackSqliteStateOptions | undefined): string {
  return (
    resolveSlackStateDirOverride(options) ??
    getSlackRuntime().state.resolveStateDir(options?.env ?? process.env, options?.homedir)
  );
}

const sqliteMutationLocks = new KeyedAsyncQueue();
const SLACK_MUTATION_LOCK_OPTIONS = {
  retries: {
    retries: 10,
    factor: 2,
    minTimeout: 100,
    maxTimeout: 10_000,
    randomize: true,
  },
  stale: 30_000,
} as const;

async function withSlackProcessMutationLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  return await sqliteMutationLocks.enqueue(lockPath, fn);
}

/**
 * Serialize poll mutations both within this process and across processes that
 * share the same state directory, so concurrent vote writes cannot clobber
 * each other's buckets.
 */
export async function withSlackSqliteMutationLock<T>(
  options: SlackSqliteStateOptions | undefined,
  mutationKey: string,
  fn: () => Promise<T>,
): Promise<T> {
  const scopedMutationKey = path.join(resolveSlackSqliteStateDir(options), mutationKey);
  return await withSlackProcessMutationLock(scopedMutationKey, async () => {
    return await withFileLock(scopedMutationKey, SLACK_MUTATION_LOCK_OPTIONS, fn);
  });
}
