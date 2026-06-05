// Msteams plugin module implements sqlite state behavior.
import path from "node:path";
import { getMSTeamsRuntime } from "./runtime.js";
import { withFileLock } from "./store-fs.js";

export type MSTeamsSqliteStateOptions = {
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

export function resolveMSTeamsSqliteStateDir(
  options: MSTeamsSqliteStateOptions | undefined,
): string {
  return (
    resolveStateDirOverride(options) ??
    getMSTeamsRuntime().state.resolveStateDir(options?.env ?? process.env, options?.homedir)
  );
}

const sqliteMutationLocks = new Map<string, Promise<unknown>>();

async function withProcessMutationLock<T>(lockPath: string, fn: () => Promise<T>): Promise<T> {
  const previous = sqliteMutationLocks.get(lockPath) ?? Promise.resolve();
  let release: () => void = () => {};
  const next = new Promise<void>((resolve) => {
    release = resolve;
  });
  const chained = previous.then(
    () => next,
    () => next,
  );
  sqliteMutationLocks.set(lockPath, chained);
  await previous.catch(() => undefined);
  try {
    return await fn();
  } finally {
    release();
    if (sqliteMutationLocks.get(lockPath) === chained) {
      sqliteMutationLocks.delete(lockPath);
    }
  }
}

export async function withMSTeamsSqliteMutationLock<T>(
  options: MSTeamsSqliteStateOptions | undefined,
  lockFilename: string,
  fn: () => Promise<T>,
): Promise<T> {
  const lockPath = path.join(resolveMSTeamsSqliteStateDir(options), lockFilename);
  return await withProcessMutationLock(lockPath, async () => {
    return await withFileLock(lockPath, { version: 1 }, fn);
  });
}
