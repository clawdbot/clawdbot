import { withFileLock } from "../../infra/file-lock.js";
import { OAUTH_REFRESH_LOCK_OPTIONS } from "./constants.js";
import { resolveOAuthRefreshLockPath } from "./paths.js";

export type OAuthProfileLockKey = {
  profileId: string;
  provider: string;
};

/** Serialize every mutation that can create, consume, or remove one OAuth generation. */
export async function withOAuthProfileLock<T>(
  key: OAuthProfileLockKey,
  operation: () => Promise<T>,
  options?: { env?: NodeJS.ProcessEnv },
): Promise<T> {
  return await withFileLock(
    resolveOAuthRefreshLockPath(key.provider, key.profileId, options?.env),
    OAUTH_REFRESH_LOCK_OPTIONS,
    operation,
  );
}

/** Acquire multiple profile locks in stable order to avoid cross-profile deadlocks. */
export async function withOAuthProfileLocks<T>(
  keys: readonly OAuthProfileLockKey[],
  operation: () => Promise<T>,
  options?: { env?: NodeJS.ProcessEnv },
): Promise<T> {
  const ordered = [
    ...new Map(keys.map((key) => [`${key.provider}\0${key.profileId}`, key] as const)).values(),
  ].toSorted(
    (left, right) =>
      left.provider.localeCompare(right.provider) || left.profileId.localeCompare(right.profileId),
  );
  const enter = async (index: number): Promise<T> => {
    const key = ordered[index];
    return key
      ? await withOAuthProfileLock(key, async () => await enter(index + 1), options)
      : await operation();
  };
  return await enter(0);
}
