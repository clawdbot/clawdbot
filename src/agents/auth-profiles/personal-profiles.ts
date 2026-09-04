import {
  readUserModelAuthProfile,
  updateUserModelAuthProfile,
} from "../../state/user-model-accounts.js";
import { AUTH_STORE_VERSION } from "./constants.js";
import type { AuthProfileStore } from "./types.js";

/** Personal credentials enter only the selected turn's view, never the shared profile pool. */
export function materializePersonalAuthProfile(
  store: AuthProfileStore,
  profileId: string,
): AuthProfileStore {
  const profile = readUserModelAuthProfile(profileId);
  if (!profile) {
    return store;
  }
  return {
    ...store,
    profiles: { ...store.profiles, [profileId]: profile.credential },
    runtimePersistedProfileIds: [
      ...new Set([...(store.runtimePersistedProfileIds ?? []), profileId]),
    ].toSorted(),
    ...(profile.usageStats
      ? { usageStats: { ...store.usageStats, [profileId]: profile.usageStats } }
      : {}),
  };
}

/** Reuses canonical credential/usage mutators within the personal credential owner's transaction. */
export function updatePersonalAuthProfileStore(params: {
  profileId: string;
  updater: (store: AuthProfileStore) => boolean;
  stateDir?: string;
}): AuthProfileStore {
  const store: AuthProfileStore = { version: AUTH_STORE_VERSION, profiles: {} };
  updateUserModelAuthProfile(
    params.profileId,
    (profile) => {
      store.profiles[params.profileId] = profile.credential;
      store.usageStats = profile.usageStats
        ? { [params.profileId]: profile.usageStats }
        : undefined;
      if (!params.updater(store)) {
        return false;
      }
      const credential = store.profiles[params.profileId];
      if (!credential) {
        throw new Error(
          "Personal model accounts must be disconnected through their profile owner.",
        );
      }
      profile.credential = credential;
      profile.usageStats = store.usageStats?.[params.profileId];
      return true;
    },
    params.stateDir ? { env: { ...process.env, OPENCLAW_STATE_DIR: params.stateDir } } : undefined,
  );
  return store;
}
