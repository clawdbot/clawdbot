/**
 * Locked auth profile upsert helper.
 * Normalizes literal secrets before persistence and routes all writes through
 * the shared SQLite lock to avoid racing concurrent auth updates.
 */
import { normalizeSecretInput } from "../../utils/normalize-secret-input.js";
import { updateAuthProfileStoreWithLock } from "./store.js";
import type { AuthProfileCredential, AuthProfileStore } from "./types.js";

// Upserts normalize literal secrets before persistence; SecretRef fields are
// preserved by leaving non-string key/token values untouched.
function normalizeAuthProfileCredential(credential: AuthProfileCredential): AuthProfileCredential {
  if (credential.type === "api_key") {
    if (typeof credential.key !== "string") {
      return credential;
    }
    const { key: _key, ...rest } = credential;
    const key = normalizeSecretInput(credential.key);
    return {
      ...rest,
      ...(key ? { key } : {}),
    };
  }
  if (credential.type === "token") {
    if (typeof credential.token !== "string") {
      return credential;
    }
    const { token: _token, ...rest } = credential;
    const token = normalizeSecretInput(credential.token);
    return { ...rest, ...(token ? { token } : {}) };
  }
  return credential;
}

/** Upserts an auth profile under the store lock, returning null on write failure. */
export async function upsertAuthProfileWithLock(params: {
  profileId: string;
  credential: AuthProfileCredential;
  agentDir?: string;
}): Promise<AuthProfileStore | null> {
  try {
    const credential = normalizeAuthProfileCredential(params.credential);
    return await updateAuthProfileStoreWithLock({
      agentDir: params.agentDir,
      saveOptions: {
        filterExternalAuthProfiles: false,
        syncExternalCli: false,
      },
      updater: (store) => {
        store.profiles[params.profileId] = credential;
        return true;
      },
    });
  } catch {
    return null;
  }
}
