// Msteams plugin module implements sqlite state behavior.
import path from "node:path";
import { withFileLock } from "openclaw/plugin-sdk/file-lock";
import { KeyedAsyncQueue } from "openclaw/plugin-sdk/keyed-async-queue";
import { getMSTeamsRuntime } from "./runtime.js";

type MSTeamsSqliteStateOptions = {
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  stateDir?: string;
  storePath?: string;
};

function resolveStateDirOverride(
  options: MSTeamsSqliteStateOptions | undefined,
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
    return getMSTeamsRuntime().state.resolveStateDir(options.env ?? process.env, options.homedir);
  }
  return options.env?.OPENCLAW_STATE_DIR?.trim() || undefined;
}

export function resolveMSTeamsSqliteStateEnv(
  options: MSTeamsSqliteStateOptions | undefined,
): NodeJS.ProcessEnv | undefined {
  const stateDir = resolveStateDirOverride(options);
  if (!stateDir) {
    return options?.env;
  }
  return {
    ...(options?.env ?? process.env),
    OPENCLAW_STATE_DIR: stateDir,
  };
}

export function toPluginJsonValue<T>(value: T): T {
  const serialized = JSON.stringify(value);
  return JSON.parse(serialized) as T;
}

function resolveMSTeamsSqliteStateDir(options: MSTeamsSqliteStateOptions | undefined): string {
  return (
    resolveStateDirOverride(options) ??
    getMSTeamsRuntime().state.resolveStateDir(options?.env ?? process.env, options?.homedir)
  );
}

const sqliteMutationLocks = new KeyedAsyncQueue();
const MSTEAMS_MUTATION_LOCK_OPTIONS = {
  retries: {
    retries: 10,
    factor: 2,
    minTimeout: 100,
    maxTimeout: 10_000,
    randomize: true,
  },
  stale: 30_000,
} as const;

async function withProcessMutationLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  return await sqliteMutationLocks.enqueue(lockPath, fn);
}

export async function withMSTeamsSqliteMutationLock<T>(
  options: MSTeamsSqliteStateOptions | undefined,
  mutationKey: string,
  fn: () => Promise<T>,
): Promise<T> {
  const scopedMutationKey = path.join(resolveMSTeamsSqliteStateDir(options), mutationKey);
  return await withProcessMutationLock(scopedMutationKey, async () => {
    return await withFileLock(scopedMutationKey, MSTEAMS_MUTATION_LOCK_OPTIONS, fn);
  });
}
