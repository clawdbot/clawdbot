/**
 * Auth profile mutation helpers.
 * Updates profile order, last-good state, usage stats, and provider profile
 * records through locked or immediate store writes.
 */
import { isDeepStrictEqual } from "node:util";
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { err, ok, type Result } from "@openclaw/normalization-core/result";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { createSubsystemLogger } from "../../logging/subsystem.js";
import { isUserModelAuthProfileId } from "../../state/user-model-account-id.js";
import { resolveProviderIdForAuth } from "../provider-auth-aliases.js";
import { normalizeAuthProfileCredential } from "./credential-normalize.js";
import { withOAuthProfileLocks, type OAuthProfileLockKey } from "./oauth-profile-lock.js";
import { removeOAuthRefreshGenerationPeers } from "./oauth-refresh-peers.js";
import { resolveSharedAuthStorePath } from "./path-resolve.js";
import { dedupeProfileIds, listProfilesForProvider } from "./profile-list.js";
import { removeRuntimeExternalProfileReferences } from "./runtime-external-profile-references.js";
import { resolveSharedMainAuthAgentDir } from "./shared-main-dir.js";
import { resolveAuthProfileDatabasePath } from "./sqlite.js";
import {
  ensureAuthProfileStoreForLocalUpdate,
  loadAuthProfileStoreWithoutExternalProfiles,
  saveAuthProfileStore,
  updateAuthProfileStoreWithLock,
} from "./store-runtime.js";
import {
  isSharedMainAuthProfileAgentDir,
  resolvePersistedAuthProfileOwnerAgentDir,
  resolveRuntimeAuthProfileAgentDir,
} from "./store.js";
import type { AuthProfileCredential, AuthProfileStore } from "./types.js";
import { resetAuthProfileFailureState } from "./usage-state.js";
export {
  dedupeProfileIds,
  listProfilesForProvider,
  resolveSubscriptionAuthModeForProfiles,
} from "./profile-list.js";
export { upsertAuthProfileWithLock, upsertAuthProfileWithLockOrThrow } from "./upsert-with-lock.js";

const authProfileProfilesLog = createSubsystemLogger("agent/embedded");
const OAUTH_REMOVAL_MAX_ATTEMPTS = 3;

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
  sharedStoreWrite?: boolean;
}): Promise<AuthProfileStore | null> {
  const providerKey = resolveProviderIdForAuth(params.provider);
  const sanitized =
    params.order && Array.isArray(params.order) ? normalizeStringEntries(params.order) : [];
  const deduped = dedupeProfileIds(sanitized);

  return await updateAuthProfileStoreWithLock({
    agentDir: params.agentDir,
    sharedStoreWrite: params.sharedStoreWrite,
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
  cfg?: OpenClawConfig;
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
  for (let attempt = 0; attempt < OAUTH_REMOVAL_MAX_ATTEMPTS; attempt += 1) {
    const targets = owners.map((owner) =>
      createAuthProfileRemovalTarget({
        agentDir: owner,
        ...(params.profileIds
          ? { profileIds: new Set(params.profileIds) }
          : { provider: params.provider }),
      }),
    );
    const result = await removeAuthProfileTargetsWithLocks(targets, params.cfg ?? {});
    if (result.kind === "updated") {
      return result.stores.at(-1) ?? null;
    }
    if (result.kind === "contention") {
      return null;
    }
  }
  return null;
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

type AuthProfileRemovalTarget = {
  agentDir?: string;
  profileIds: ReadonlySet<string>;
  provider?: string;
  expectedProfiles: ReadonlyMap<string, AuthProfileCredential | undefined>;
};

function createAuthProfileRemovalTarget(params: {
  agentDir?: string;
  profileIds?: ReadonlySet<string>;
  provider?: string;
}): AuthProfileRemovalTarget {
  const store = loadAuthProfileStoreWithoutExternalProfiles(params.agentDir, {
    allowKeychainPrompt: false,
  });
  const profileIds =
    params.profileIds ?? new Set(listProfilesForProvider(store, params.provider ?? ""));
  return {
    agentDir: params.agentDir,
    profileIds,
    ...(params.provider ? { provider: params.provider } : {}),
    expectedProfiles: new Map(
      [...profileIds].map((profileId) => [profileId, store.profiles[profileId]]),
    ),
  };
}

function authProfileRemovalTargetMatches(
  target: AuthProfileRemovalTarget,
  store: AuthProfileStore,
): boolean {
  if (target.provider) {
    const currentProfileIds = new Set(listProfilesForProvider(store, target.provider));
    if (
      currentProfileIds.size !== target.profileIds.size ||
      [...currentProfileIds].some((profileId) => !target.profileIds.has(profileId))
    ) {
      return false;
    }
  }
  return [...target.expectedProfiles].every(([profileId, expected]) =>
    isDeepStrictEqual(store.profiles[profileId], expected),
  );
}

type AuthProfileRemovalResult =
  | { kind: "retry" }
  | { kind: "contention" }
  | { kind: "updated"; stores: AuthProfileStore[] };

async function removeAuthProfileTargetsWithLocks(
  targets: readonly AuthProfileRemovalTarget[],
  cfg: OpenClawConfig,
): Promise<AuthProfileRemovalResult> {
  const lockKeys: OAuthProfileLockKey[] = targets.flatMap((target) =>
    [...target.expectedProfiles].flatMap(([profileId, credential]) =>
      credential?.type === "oauth" ? [{ profileId, provider: credential.provider }] : [],
    ),
  );
  return await withOAuthProfileLocks(lockKeys, async () => {
    for (const target of targets) {
      const current = loadAuthProfileStoreWithoutExternalProfiles(target.agentDir, {
        allowKeychainPrompt: false,
      });
      if (!authProfileRemovalTargetMatches(target, current)) {
        return { kind: "retry" };
      }
    }

    for (const target of targets) {
      for (const [profileId, credential] of target.expectedProfiles) {
        if (credential?.type !== "oauth") {
          continue;
        }
        await removeOAuthRefreshGenerationPeers({
          cfg,
          ownerDatabasePath: target.agentDir
            ? resolveAuthProfileDatabasePath(target.agentDir)
            : resolveSharedAuthStorePath(),
          profileId,
          generation: credential,
        });
      }
    }

    const stores: AuthProfileStore[] = [];
    for (const target of targets) {
      let stale = false;
      const updated = await updateAuthProfileStoreWithLock({
        agentDir: target.agentDir,
        updater: (store) => {
          if (!authProfileRemovalTargetMatches(target, store)) {
            stale = true;
            return false;
          }
          return removeProfileReferences(store, target.profileIds, target.provider);
        },
      });
      if (updated === null) {
        return { kind: "contention" };
      }
      if (stale) {
        return { kind: "retry" };
      }
      stores.push(updated);
    }
    return { kind: "updated", stores };
  });
}

/**
 * Removes profiles from every store that owns them. Auth profiles can be
 * adopted by a provider-specific owner agent dir, so removing only the caller's
 * store lets the profile reappear on the next status read and auth warmup.
 */
export async function removeAuthProfilesAcrossOwnerStores(params: {
  cfg?: OpenClawConfig;
  agentDir?: string;
  profileIds: readonly string[];
}): Promise<boolean> {
  const profileIds = new Set(params.profileIds);
  if ([...profileIds].some(isUserModelAuthProfileId)) {
    throw new Error(
      "Personal model accounts are managed in Settings → Profile → Connected accounts. Clearing a default keeps the credential; revoke access with the provider instead of removing a shared auth profile.",
    );
  }
  for (let attempt = 0; attempt < OAUTH_REMOVAL_MAX_ATTEMPTS; attempt += 1) {
    const profilesByOwner = new Map<string | undefined, Set<string>>([
      [params.agentDir, profileIds],
    ]);
    for (const profileId of profileIds) {
      const ownerAgentDir = resolvePersistedAuthProfileOwnerAgentDir({
        agentDir: params.agentDir,
        profileId,
      });
      const ownerProfiles = profilesByOwner.get(ownerAgentDir) ?? new Set<string>();
      ownerProfiles.add(profileId);
      profilesByOwner.set(ownerAgentDir, ownerProfiles);
    }
    const result = await removeAuthProfileTargetsWithLocks(
      [...profilesByOwner].map(([agentDir, ownerProfileIds]) =>
        createAuthProfileRemovalTarget({ agentDir, profileIds: ownerProfileIds }),
      ),
      params.cfg ?? {},
    );
    if (result.kind === "updated") {
      return true;
    }
    if (result.kind === "contention") {
      return false;
    }
  }
  return false;
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
    profileId: params.profileId,
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
  const personal = isUserModelAuthProfileId(profileId);
  const inherited =
    !personal && ownerAgentDir === undefined && !isSharedMainAuthProfileAgentDir(agentDir);
  const updatesSelection = !inherited && !personal;
  const lastUsed = Date.now();
  let applied = false;
  const updated = await updateAuthProfileStoreWithLock({
    agentDir: ownerAgentDir,
    profileId,
    updater: (freshStore) => {
      const freshProfile = freshStore.profiles[profileId];
      if (!freshProfile || resolveProviderIdForAuth(freshProfile.provider) !== providerKey) {
        return false;
      }
      // Inherited selection ownership is not defined. Clear shared health in
      // the credential owner without changing its last-good or rotation state.
      if (updatesSelection) {
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
    if (updatesSelection) {
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
