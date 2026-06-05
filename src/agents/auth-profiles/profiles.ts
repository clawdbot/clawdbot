/**
 * Auth profile mutation helpers.
 * Updates profile order, last-good state, usage stats, and provider profile
 * records through locked or immediate store writes.
 */
import {
  findNormalizedProviderKey,
  normalizeProviderId,
} from "@openclaw/model-catalog-core/provider-id";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { normalizeSecretInput } from "../../utils/normalize-secret-input.js";
import { resolveProviderIdForAuth } from "../provider-auth-aliases.js";
import { dedupeProfileIds, listProfilesForProvider } from "./profile-list.js";
import {
  ensureAuthProfileStoreForLocalUpdate,
  saveAuthProfileStore,
  updateAuthProfileStoreWithLock,
} from "./store.js";
import type { AuthProfileCredential, AuthProfileStore, ProfileUsageStats } from "./types.js";
export { dedupeProfileIds, listProfilesForProvider } from "./profile-list.js";

// Auth profile order/lastGood keys may be stored as aliases. Resolve through
// auth provider normalization before updating per-provider state.
function findProviderAuthStateKey(
  entries: Record<string, unknown> | undefined,
  providerKey: string,
): string | undefined {
  if (!entries) {
    return undefined;
  }
  const normalizedProviderKey = resolveProviderIdForAuth(providerKey);
  return Object.keys(entries).find(
    (key) => resolveProviderIdForAuth(key) === normalizedProviderKey,
  );
}

// Successful auth clears transient failure/cooldown/disable state while keeping
// unrelated metadata and updating lastUsed for round-robin ordering.
function resetSuccessfulUsageStats(
  existing: ProfileUsageStats | undefined,
  lastUsed: number,
): ProfileUsageStats {
  return {
    ...existing,
    errorCount: 0,
    blockedUntil: undefined,
    blockedReason: undefined,
    blockedSource: undefined,
    blockedModel: undefined,
    cooldownUntil: undefined,
    cooldownReason: undefined,
    cooldownModel: undefined,
    disabledUntil: undefined,
    disabledReason: undefined,
    failureCounts: undefined,
    lastUsed,
  };
}

function updateSuccessfulUsageStatsEntry(
  store: AuthProfileStore,
  profileId: string,
  lastUsed: number,
): void {
  store.usageStats = store.usageStats ?? {};
  store.usageStats[profileId] = resetSuccessfulUsageStats(store.usageStats[profileId], lastUsed);
}

/** Sets or clears explicit auth profile order for a provider. */
export async function setAuthProfileOrder(params: {
  agentDir?: string;
  provider: string;
  order?: string[] | null;
}): Promise<AuthProfileStore | null> {
  const providerKey = normalizeProviderId(params.provider);
  const sanitized =
    params.order && Array.isArray(params.order) ? normalizeStringEntries(params.order) : [];
  const deduped = dedupeProfileIds(sanitized);

  return await updateAuthProfileStoreWithLock({
    agentDir: params.agentDir,
    updater: (store) => {
      store.order = store.order ?? {};
      if (deduped.length === 0) {
        if (!store.order[providerKey]) {
          return false;
        }
        delete store.order[providerKey];
        if (Object.keys(store.order).length === 0) {
          store.order = undefined;
        }
        return true;
      }
      store.order[providerKey] = deduped;
      return true;
    },
  });
}

/** Promotes one auth profile to the front of a provider order. */
export async function promoteAuthProfileInOrder(params: {
  agentDir?: string;
  provider: string;
  profileId: string;
  createIfMissing?: boolean;
  createFromOrder?: string[];
}): Promise<AuthProfileStore | null> {
  const providerKey = resolveProviderIdForAuth(params.provider);
  return await updateAuthProfileStoreWithLock({
    agentDir: params.agentDir,
    ...(params.createFromOrder
      ? { saveOptions: { preserveOrderProfileIds: params.createFromOrder } }
      : {}),
    updater: (store) => {
      const profile = store.profiles[params.profileId];
      if (!profile || resolveProviderIdForAuth(profile.provider) !== providerKey) {
        return false;
      }
      const orderKey =
        findProviderAuthStateKey(store.order, providerKey) ??
        findNormalizedProviderKey(store.order, providerKey) ??
        normalizeProviderId(providerKey);
      const existing = store.order?.[orderKey];
      if (!existing || existing.length === 0) {
        if (!params.createIfMissing) {
          return false;
        }
        const providerProfiles = dedupeProfileIds(
          params.createFromOrder !== undefined
            ? params.createFromOrder
            : listProfilesForProvider(store, providerKey),
        );
        const next = dedupeProfileIds([
          params.profileId,
          ...providerProfiles.filter((profileId) => profileId !== params.profileId),
        ]);
        store.order = { ...store.order, [orderKey]: next };
        return true;
      }
      const next = dedupeProfileIds([
        params.profileId,
        ...existing.filter((profileId) => profileId !== params.profileId),
      ]);
      if (
        next.length === existing.length &&
        next.every((profileId, idx) => profileId === existing[idx])
      ) {
        return false;
      }
      store.order = { ...store.order, [orderKey]: next };
      return true;
    },
  });
}

// Upsert paths normalize literal secret strings but preserve SecretRef-backed
// credentials for the secret resolver.
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

/** Upserts an auth profile immediately into the local store. */
export function upsertAuthProfile(params: {
  profileId: string;
  credential: AuthProfileCredential;
  agentDir?: string;
}): void {
  const credential = normalizeAuthProfileCredential(params.credential);
  const store = ensureAuthProfileStoreForLocalUpdate(params.agentDir);
  store.profiles[params.profileId] = credential;
  saveAuthProfileStore(store, params.agentDir, {
    filterExternalAuthProfiles: false,
    syncExternalCli: false,
  });
}

/** Upserts an auth profile under the auth store lock. */
export async function upsertAuthProfileWithLock(params: {
  profileId: string;
  credential: AuthProfileCredential;
  agentDir?: string;
}): Promise<AuthProfileStore | null> {
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
}

/** Removes all auth profiles and related state for a provider. */
export async function removeProviderAuthProfilesWithLock(params: {
  provider: string;
  agentDir?: string;
}): Promise<AuthProfileStore | null> {
  const providerKey = resolveProviderIdForAuth(params.provider);
  const storeOrderKey = normalizeProviderId(params.provider);
  return await updateAuthProfileStoreWithLock({
    agentDir: params.agentDir,
    updater: (store) => {
      const profileIds = listProfilesForProvider(store, params.provider);
      let changed = false;
      for (const profileId of profileIds) {
        if (store.profiles[profileId]) {
          delete store.profiles[profileId];
          changed = true;
        }
        if (store.usageStats?.[profileId]) {
          delete store.usageStats[profileId];
          changed = true;
        }
      }
      if (store.order?.[storeOrderKey]) {
        delete store.order[storeOrderKey];
        changed = true;
        if (Object.keys(store.order).length === 0) {
          store.order = undefined;
        }
      }
      if (store.lastGood?.[providerKey]) {
        delete store.lastGood[providerKey];
        changed = true;
        if (Object.keys(store.lastGood).length === 0) {
          store.lastGood = undefined;
        }
      }
      if (store.usageStats && Object.keys(store.usageStats).length === 0) {
        store.usageStats = undefined;
      }
      return changed;
    },
  });
}

/** Clear the last-good profile pointer for a provider under the store lock. */
export async function clearLastGoodProfileWithLock(params: {
  provider: string;
  profileId: string;
  agentDir?: string;
}): Promise<AuthProfileStore | null> {
  const providerKey = resolveProviderIdForAuth(params.provider);
  return await updateAuthProfileStoreWithLock({
    agentDir: params.agentDir,
    updater: (store) => {
      const lastGoodKey = findProviderAuthStateKey(store.lastGood, providerKey);
      if (!lastGoodKey || store.lastGood?.[lastGoodKey] !== params.profileId) {
        return false;
      }
      delete store.lastGood[lastGoodKey];
      if (Object.keys(store.lastGood).length === 0) {
        store.lastGood = undefined;
      }
      return true;
    },
  });
}

/** Mark a profile as successfully used and update ordering/usage metadata. */
export async function markAuthProfileSuccess(params: {
  store: AuthProfileStore;
  provider: string;
  profileId: string;
  agentDir?: string;
}): Promise<void> {
  const { store, provider, profileId, agentDir } = params;
  const providerKey = resolveProviderIdForAuth(provider);
  const lastUsed = Date.now();
  const updated = await updateAuthProfileStoreWithLock({
    agentDir,
    updater: (freshStore) => {
      const profile = freshStore.profiles[profileId];
      if (!profile || resolveProviderIdForAuth(profile.provider) !== providerKey) {
        return false;
      }
      freshStore.lastGood = { ...freshStore.lastGood, [providerKey]: profileId };
      updateSuccessfulUsageStatsEntry(freshStore, profileId, lastUsed);
      return true;
    },
  });
  if (updated) {
    store.lastGood = updated.lastGood;
    store.usageStats = updated.usageStats;
    return;
  }
  const profile = store.profiles[profileId];
  if (!profile || resolveProviderIdForAuth(profile.provider) !== providerKey) {
    return;
  }
  store.lastGood = { ...store.lastGood, [providerKey]: profileId };
  updateSuccessfulUsageStatsEntry(store, profileId, lastUsed);
  saveAuthProfileStore(store, agentDir);
}
