/**
 * Auth profile mutation helpers.
 * Updates profile order, last-good state, usage stats, and provider profile
 * records through locked or immediate store writes.
 */
import { isDeepStrictEqual } from "node:util";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { resolveProviderIdForAuth } from "../provider-auth-aliases.js";
import { normalizeAuthProfileCredential } from "./credential-normalize.js";
import { dedupeProfileIds, listProfilesForProvider } from "./profile-list.js";
import { removeRuntimeExternalProfileReferences } from "./runtime-external-profile-references.js";
import { resolveSharedMainAuthAgentDir } from "./shared-main-dir.js";
import { resolveAuthProfileDatabasePath } from "./sqlite.js";
import {
  ensureAuthProfileStoreForLocalUpdate,
  isSharedMainAuthProfileAgentDir,
  resolvePersistedAuthProfileOwnerAgentDir,
  resolveRuntimeAuthProfileAgentDir,
  saveAuthProfileStore,
  updateAuthProfileStoreWithLock,
} from "./store.js";
import type { AuthProfileCredential, AuthProfileStore } from "./types.js";
import { resetAuthProfileFailureState } from "./usage-state.js";
export {
  dedupeProfileIds,
  listProfilesForProvider,
  resolveSubscriptionAuthModeForProfiles,
} from "./profile-list.js";
export {
  upsertAuthProfileAfterLoginWithLockOrThrow,
  upsertAuthProfileWithLock,
  upsertAuthProfileWithLockOrThrow,
} from "./upsert-with-lock.js";

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

function updateSuccessfulUsageStatsEntry(
  store: AuthProfileStore,
  profileId: string,
  lastUsed?: number,
): void {
  store.usageStats = store.usageStats ?? {};
  store.usageStats[profileId] = resetAuthProfileFailureState(
    store.usageStats[profileId] ?? {},
    lastUsed === undefined ? undefined : { lastUsed },
  );
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

/** Promotes across shared-credential/local-order owners; otherwise relogin leaves stale order. */
export async function promoteAuthProfileInOrder(params: {
  agentDir?: string;
  provider: string;
  profileId: string;
  createIfMissing?: boolean;
  createFromOrder?: string[];
}): Promise<Result<AuthProfileStore, "lock-contention">> {
  const providerKey = resolveProviderIdForAuth(params.provider);
  const effectiveStore = ensureAuthProfileStoreForLocalUpdate(params.agentDir);
  const updated = await updateAuthProfileStoreWithLock({
    agentDir: params.agentDir,
    saveOptions: { preserveOrderProfileIds: [params.profileId, ...(params.createFromOrder ?? [])] },
    updater: (store) => {
      const profile = store.profiles[params.profileId] ?? effectiveStore.profiles[params.profileId];
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
  return updated === null ? err("lock-contention") : ok(updated);
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

/** Removes auth profiles and related state for a provider, optionally narrowed to exact IDs. */
export async function removeProviderAuthProfilesWithLock(params: {
  provider: string;
  agentDir?: string;
  profileIds?: readonly string[];
}): Promise<AuthProfileStore | null> {
  const agentDir = resolveRuntimeAuthProfileAgentDir(params.agentDir);
  const owners: Array<string | undefined> = [agentDir];
  if (
    agentDir &&
    !isSharedMainAuthProfileAgentDir(agentDir) &&
    resolveAuthProfileDatabasePath(agentDir) ===
      resolveAuthProfileDatabasePath(resolveSharedMainAuthAgentDir())
  ) {
    // Main login writes shared credentials; clear that owner before its local overrides.
    // Other agents must not erase credentials inherited from the shared store.
    owners.unshift(undefined);
  }
  let updated: AuthProfileStore | null = null;
  for (const owner of owners) {
    updated = await updateAuthProfileStoreWithLock({
      agentDir: owner,
      updater: (store) =>
        removeProfileReferences(
          store,
          new Set(params.profileIds ?? listProfilesForProvider(store, params.provider)),
          params.profileIds ? undefined : params.provider,
        ),
    });
    if (updated === null) {
      return null;
    }
  }
  return updated;
}

function removeProfileReferences(
  store: AuthProfileStore,
  profileIds: ReadonlySet<string>,
  provider?: string,
): boolean {
  const next = { ...removeRuntimeExternalProfileReferences({ store, profileIds }) };
  if (provider !== undefined && next.order) {
    next.order = replaceProviderAuthState(next.order, provider);
  }
  if (provider !== undefined && next.lastGood) {
    next.lastGood = replaceProviderAuthState(next.lastGood, provider);
  }
  if (isDeepStrictEqual(store, next)) {
    return false;
  }
  Object.assign(store, next);
  return true;
}

/** Removes selected auth profiles and every state pointer that references them. */
export async function removeAuthProfilesWithLock(params: {
  profileIds: readonly string[];
  agentDir?: string;
}): Promise<AuthProfileStore | null> {
  const profileIds = new Set(params.profileIds);
  return await updateAuthProfileStoreWithLock({
    agentDir: params.agentDir,
    updater: (store) => removeProfileReferences(store, profileIds),
  });
}

/**
 * Removes profiles from every store that owns them. Auth profiles can be
 * adopted by a provider-specific owner agent dir, so removing only the caller's
 * store lets the profile reappear on the next status read and auth warmup.
 */
export async function removeAuthProfilesAcrossOwnerStores(params: {
  agentDir?: string;
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
  const profile = store.profiles[profileId];
  if (!profile || resolveProviderIdForAuth(profile.provider) !== providerKey) {
    return;
  }
  const ownerAgentDir = resolvePersistedAuthProfileOwnerAgentDir({ agentDir, profileId });
  const inherited = ownerAgentDir === undefined && !isSharedMainAuthProfileAgentDir(agentDir);
  const lastUsed = Date.now();
  let applied = false;
  const updated = await updateAuthProfileStoreWithLock({
    agentDir: ownerAgentDir,
    updater: (freshStore) => {
      const freshProfile = freshStore.profiles[profileId];
      if (!freshProfile || resolveProviderIdForAuth(freshProfile.provider) !== providerKey) {
        return false;
      }
      // Inherited selection ownership is not defined. Clear shared health in
      // the credential owner without changing its last-good or rotation state.
      if (!inherited) {
        freshStore.lastGood = replaceProviderAuthState(freshStore.lastGood, providerKey, profileId);
      }
      updateSuccessfulUsageStatsEntry(freshStore, profileId, inherited ? undefined : lastUsed);
      applied = true;
      return true;
    },
  });
  if (updated && applied) {
    const usage = updated.usageStats?.[profileId];
    if (usage) {
      store.usageStats = { ...store.usageStats, [profileId]: usage };
    }
    if (!inherited) {
      store.lastGood = replaceProviderAuthState(store.lastGood, providerKey, profileId);
    }
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
