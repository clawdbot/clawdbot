/**
 * Auth profile mutation helpers.
 * Updates profile order, last-good state, usage stats, and provider profile
 * records through locked or immediate store writes.
 */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveProviderIdForAuth } from "../provider-auth-aliases.js";
import { normalizeAuthProfileCredential } from "./credential-normalize.js";
import { dedupeProfileIds, listProfilesForProvider } from "./profile-list.js";
import {
  ensureAuthProfileStoreForLocalUpdate,
  resolvePersistedAuthProfileOwnerAgentDir,
  saveAuthProfileStore,
  updateAuthProfileStoreWithLock,
} from "./store.js";
import type { AuthProfileCredential, AuthProfileStore, ProfileUsageStats } from "./types.js";
export {
  dedupeProfileIds,
  listProfilesForProvider,
  resolveSubscriptionAuthModeForProfiles,
} from "./profile-list.js";
export { upsertAuthProfileWithLock, upsertAuthProfileWithLockOrThrow } from "./upsert-with-lock.js";

const authProfileProfilesLog = createSubsystemLogger("agent/embedded");

function listProviderAuthStateEntries<T>(
  entries: Record<string, T> | undefined,
  provider: string,
): Array<[string, T]> {
  const canonicalProvider = resolveProviderIdForAuth(provider);
  return Object.entries(entries ?? {})
    .filter(([key]) => resolveProviderIdForAuth(key) === canonicalProvider)
    .toSorted(([left], [right]) => left.localeCompare(right));
}

function readProviderAuthState<T>(
  entries: Record<string, T> | undefined,
  provider: string,
): T | undefined {
  const canonicalProvider = resolveProviderIdForAuth(provider);
  const matches = listProviderAuthStateEntries(entries, canonicalProvider);
  return (
    matches.find(([key]) => normalizeProviderId(key) === canonicalProvider)?.[1] ?? matches[0]?.[1]
  );
}

function replaceProviderAuthState<T>(
  entries: Record<string, T> | undefined,
  provider: string,
  value?: T,
): Record<string, T> | undefined {
  const canonicalProvider = resolveProviderIdForAuth(provider);
  const next = Object.fromEntries(
    Object.entries(entries ?? {}).filter(
      ([key]) => resolveProviderIdForAuth(key) !== canonicalProvider,
    ),
  ) as Record<string, T>;
  if (value !== undefined) {
    next[canonicalProvider] = value;
  }
  return Object.keys(next).length > 0 ? next : undefined;
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
  const providerKey = resolveProviderIdForAuth(params.provider);
  const sanitized =
    params.order && Array.isArray(params.order) ? normalizeStringEntries(params.order) : [];
  const deduped = dedupeProfileIds(sanitized);

  return await updateAuthProfileStoreWithLock({
    agentDir: params.agentDir,
    // Preserve requested IDs that the agent inherits (not owns) so the local
    // save path does not prune them from the order. Without this, a secondary
    // agent's `models auth order set --agent` accepts an inherited profile ID
    // (validated against the merged store) but drops it while persisting, so
    // `order get` falls back to the inherited main order — the CLI reports a
    // switch that never happened (issue #119233). Mirrors the adjacent
    // promoteAuthProfileInOrder preservation contract; the clear-order path
    // (deduped.length === 0) must not preserve anything.
    ...(deduped.length > 0 ? { saveOptions: { preserveOrderProfileIds: deduped } } : {}),
    updater: (store) => {
      if (deduped.length === 0) {
        if (listProviderAuthStateEntries(store.order, providerKey).length === 0) {
          return false;
        }
        store.order = replaceProviderAuthState(store.order, providerKey);
        return true;
      }
      store.order = replaceProviderAuthState(store.order, providerKey, deduped);
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
      const matchingOrderEntries = listProviderAuthStateEntries(store.order, providerKey);
      const existing = readProviderAuthState(store.order, providerKey);
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
        store.order = replaceProviderAuthState(store.order, providerKey, next);
        return true;
      }
      const next = dedupeProfileIds([
        params.profileId,
        ...existing.filter((profileId) => profileId !== params.profileId),
      ]);
      if (
        next.length === existing.length &&
        next.every((profileId, idx) => profileId === existing[idx]) &&
        matchingOrderEntries.length === 1 &&
        matchingOrderEntries[0]?.[0] === providerKey
      ) {
        return false;
      }
      store.order = replaceProviderAuthState(store.order, providerKey, next);
      return true;
    },
  });
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
    sharedStoreWrite: true,
    syncExternalCli: false,
  });
}

/** Removes all auth profiles and related state for a provider. */
export async function removeProviderAuthProfilesWithLock(params: {
  provider: string;
  agentDir?: string;
}): Promise<AuthProfileStore | null> {
  const providerKey = resolveProviderIdForAuth(params.provider);
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
      if (listProviderAuthStateEntries(store.order, providerKey).length > 0) {
        store.order = replaceProviderAuthState(store.order, providerKey);
        changed = true;
      }
      if (listProviderAuthStateEntries(store.lastGood, providerKey).length > 0) {
        store.lastGood = replaceProviderAuthState(store.lastGood, providerKey);
        changed = true;
      }
      if (store.usageStats && Object.keys(store.usageStats).length === 0) {
        store.usageStats = undefined;
      }
      return changed;
    },
  });
}

/** Removes selected auth profiles and every state pointer that references them. */
export async function removeAuthProfilesWithLock(params: {
  profileIds: readonly string[];
  agentDir?: string;
}): Promise<AuthProfileStore | null> {
  const profileIds = new Set(dedupeProfileIds([...params.profileIds]));
  return await updateAuthProfileStoreWithLock({
    agentDir: params.agentDir,
    updater: (store) => {
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
      for (const [provider, order] of Object.entries(store.order ?? {})) {
        const next = order.filter((profileId) => !profileIds.has(profileId));
        if (next.length === order.length) {
          continue;
        }
        changed = true;
        if (next.length > 0) {
          store.order![provider] = next;
        } else {
          delete store.order![provider];
        }
      }
      for (const [provider, profileId] of Object.entries(store.lastGood ?? {})) {
        if (profileIds.has(profileId)) {
          delete store.lastGood![provider];
          changed = true;
        }
      }
      if (store.order && Object.keys(store.order).length === 0) {
        store.order = undefined;
      }
      if (store.lastGood && Object.keys(store.lastGood).length === 0) {
        store.lastGood = undefined;
      }
      if (store.usageStats && Object.keys(store.usageStats).length === 0) {
        store.usageStats = undefined;
      }
      return changed;
    },
  });
}

/**
 * Removes profiles from every store that owns them. Auth profiles can be
 * adopted by a provider-specific owner agent dir, so removing only the caller's
 * store lets the profile reappear on the next status read and auth warmup.
 */
export async function removeAuthProfilesAcrossOwnerStores(params: {
  agentDir: string;
  profileIds: readonly string[];
}): Promise<boolean> {
  const profilesByOwner = new Map<string | undefined, Set<string>>([
    [params.agentDir, new Set(params.profileIds)],
  ]);
  for (const profileId of params.profileIds) {
    const ownerAgentDir = resolvePersistedAuthProfileOwnerAgentDir({
      agentDir: params.agentDir,
      profileId,
    });
    const ownerProfiles = profilesByOwner.get(ownerAgentDir) ?? new Set<string>();
    ownerProfiles.add(profileId);
    profilesByOwner.set(ownerAgentDir, ownerProfiles);
  }
  for (const [ownerAgentDir, profileIds] of profilesByOwner) {
    const updatedStore = await removeAuthProfilesWithLock({
      profileIds: [...profileIds],
      agentDir: ownerAgentDir,
    });
    if (!updatedStore) {
      return false;
    }
  }
  return true;
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
      const matches = listProviderAuthStateEntries(store.lastGood, providerKey);
      if (!matches.some(([, profileId]) => profileId === params.profileId)) {
        return false;
      }
      store.lastGood = replaceProviderAuthState(store.lastGood, providerKey);
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
      freshStore.lastGood = replaceProviderAuthState(freshStore.lastGood, providerKey, profileId);
      updateSuccessfulUsageStatsEntry(freshStore, profileId, lastUsed);
      return true;
    },
  });
  if (updated) {
    store.lastGood = updated.lastGood;
    store.usageStats = updated.usageStats;
    return;
  }
  if (updated === null) {
    authProfileProfilesLog.warn(
      "dropped auth profile bookkeeping after locked store update failed",
      {
        event: "auth_profile_bookkeeping_dropped",
        kind: "success",
        profileId,
        tags: ["auth_profiles", "persistence"],
      },
    );
  }
}
