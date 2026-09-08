import { removeProviderAuthProfilesWithLock as removeProviderAuthProfilesWithLockStrict } from "../agents/auth-profiles/profiles.js";
import { updateAuthProfileStoreWithLock as updateAuthProfileStoreWithLockStrict } from "../agents/auth-profiles/store-runtime.js";
import type { AuthProfileStore } from "../agents/auth-profiles/types.js";
import { upsertAuthProfileWithLock as upsertAuthProfileWithLockStrict } from "../agents/auth-profiles/upsert-with-lock.js";

// These Plugin SDK exports shipped with nullable failure semantics. Core callers use the
// strict helpers directly so plugins retain the stable contract without masking core failures.
export async function updateAuthProfileStoreWithLockCompat(
  params: Parameters<typeof updateAuthProfileStoreWithLockStrict>[0],
): Promise<AuthProfileStore | null> {
  try {
    return await updateAuthProfileStoreWithLockStrict(params);
  } catch {
    return null;
  }
}

export async function upsertAuthProfileWithLockCompat(
  params: Parameters<typeof upsertAuthProfileWithLockStrict>[0],
): Promise<AuthProfileStore | null> {
  try {
    return await upsertAuthProfileWithLockStrict(params);
  } catch {
    return null;
  }
}

export async function removeProviderAuthProfilesWithLockCompat(
  params: Parameters<typeof removeProviderAuthProfilesWithLockStrict>[0],
): Promise<AuthProfileStore | null> {
  try {
    return await removeProviderAuthProfilesWithLockStrict(params);
  } catch {
    return null;
  }
}
