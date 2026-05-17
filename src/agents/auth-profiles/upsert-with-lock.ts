import { normalizeSecretInput } from "../../utils/normalize-secret-input.js";
import { ensureAuthStoreFile, resolveAuthStorePath } from "./paths.js";
import { updateAuthProfileStoreWithLock } from "./store.js";
import type { AuthProfileCredential, AuthProfileStore } from "./types.js";

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

export async function upsertAuthProfileWithLock(params: {
  profileId: string;
  credential: AuthProfileCredential;
  agentDir?: string;
}): Promise<AuthProfileStore | null> {
  const authPath = resolveAuthStorePath(params.agentDir);
  ensureAuthStoreFile(authPath);

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
