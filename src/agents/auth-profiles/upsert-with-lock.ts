/** Locked auth profile writes and attempt-scoped compensation. */
import { isDeepStrictEqual } from "node:util";
import { AUTH_STORE_VERSION } from "./constants.js";
import { normalizeAuthProfileCredential } from "./credential-normalize.js";
import { withOAuthProfileLock, withOAuthProfileLocks } from "./oauth-profile-lock.js";
import { isOAuthRefreshFence, isSameOAuthRefreshGeneration } from "./oauth-refresh-marker.js";
import { loadPersistedAuthProfileStore, loadPersistedSharedAuthProfileStore } from "./persisted.js";
import {
  deletePersistedAuthProfileStoreRaw,
  inspectPersistedAuthProfileStateRaw,
  inspectPersistedAuthProfileStoreRaw,
  runAuthProfileWriteTransaction,
  writePersistedAuthProfileStateRaw,
} from "./sqlite.js";
import { buildPersistedAuthProfileState } from "./state.js";
import {
  saveAuthProfileStoreWithPreparedOwner,
  updateAuthProfileStoreWithLock,
} from "./store-runtime.js";
import { findPersistedAuthProfileCredential } from "./store.js";
import type { AuthProfileCredential, AuthProfileStore } from "./types.js";
import { resetAuthProfileFailureState } from "./usage-state.js";

function throwAuthProfileUpdateError(): never {
  throw new Error(
    "Failed to update auth profile store; the auth store lock may be busy. Wait a moment and retry.",
  );
}

function restoresFencedOAuthRefreshGeneration(params: {
  profileId: string;
  existing: AuthProfileCredential | undefined;
  incoming: AuthProfileCredential;
}): boolean {
  return (
    params.existing?.type === "oauth" &&
    params.incoming.type === "oauth" &&
    params.incoming.copyToAgents !== true &&
    !isOAuthRefreshFence(params.incoming) &&
    isOAuthRefreshFence(params.existing) &&
    isSameOAuthRefreshGeneration({
      profileId: params.profileId,
      left: params.existing,
      right: params.incoming,
    })
  );
}

function loadAuthProfileWriteTarget(params: {
  agentDir?: string;
  stateDir?: string;
}): AuthProfileStore | null {
  if (params.agentDir || !params.stateDir) {
    return loadPersistedAuthProfileStore(params.agentDir);
  }
  return loadPersistedSharedAuthProfileStore({
    ...process.env,
    OPENCLAW_STATE_DIR: params.stateDir,
    OPENCLAW_AGENT_DIR: undefined,
  });
}

function resolveAuthProfileWriteEnv(params: { stateDir?: string }): NodeJS.ProcessEnv {
  return params.stateDir ? { ...process.env, OPENCLAW_STATE_DIR: params.stateDir } : process.env;
}

function loadAuthProfileWriteAuthority(
  params: { agentDir?: string; stateDir?: string },
  profileId: string,
): AuthProfileCredential | undefined {
  const target = loadAuthProfileWriteTarget(params)?.profiles[profileId];
  if (target || !params.agentDir) {
    return target;
  }
  if (params.stateDir) {
    return loadPersistedSharedAuthProfileStore({
      ...process.env,
      OPENCLAW_STATE_DIR: params.stateDir,
      OPENCLAW_AGENT_DIR: undefined,
    })?.profiles[profileId];
  }
  return findPersistedAuthProfileCredential({ agentDir: params.agentDir, profileId });
}

function supersedesOAuthRefreshGenerationObservedAtAdmission(params: {
  profileId: string;
  observed: AuthProfileCredential | undefined;
  current: AuthProfileCredential | undefined;
  incoming: AuthProfileCredential;
  allowOAuthGenerationReplacement: boolean;
}): boolean {
  if (
    params.incoming.type !== "oauth" ||
    params.incoming.copyToAgents === true ||
    isOAuthRefreshFence(params.incoming)
  ) {
    return false;
  }
  if (isDeepStrictEqual(params.current, params.observed)) {
    if (
      params.allowOAuthGenerationReplacement ||
      params.current === undefined ||
      (params.current.type === "oauth" && isOAuthRefreshFence(params.current))
    ) {
      return false;
    }
    return (
      params.current.type !== "oauth" ||
      !isSameOAuthRefreshGeneration({
        profileId: params.profileId,
        left: params.current,
        right: params.incoming,
      })
    );
  }
  if (params.observed === undefined) {
    return params.current !== undefined;
  }
  if (!params.allowOAuthGenerationReplacement) {
    return true;
  }
  return (
    params.observed.type !== "oauth" ||
    isSameOAuthRefreshGeneration({
      profileId: params.profileId,
      left: params.observed,
      right: params.incoming,
    })
  );
}

type PersistAuthProfileBatchParams = {
  profiles: readonly {
    profileId: string;
    credential: AuthProfileCredential;
    replaceExisting?: boolean;
  }[];
  order?: Readonly<Record<string, readonly string[]>>;
  agentDir?: string;
  stateDir?: string;
  resetFailureState?: boolean;
  allowOAuthGenerationReplacement?: boolean;
};

type AuthProfileBatchRollbackResult = {
  unrevertedProfileIds: ReadonlySet<string>;
};

/** Atomically persists a batch and returns conditional attempt-scoped compensation. */
export async function persistAuthProfileBatch(
  params: PersistAuthProfileBatchParams,
): Promise<{ rollback: () => AuthProfileBatchRollbackResult }> {
  const profiles = new Map(
    params.profiles.map(({ profileId, credential, replaceExisting }) => [
      profileId,
      {
        credential: normalizeAuthProfileCredential(credential),
        replaceExisting: replaceExisting !== false,
      },
    ]),
  );
  if (profiles.size === 0) {
    const result = { unrevertedProfileIds: new Set<string>() };
    return { rollback: () => result };
  }
  const observedProfiles = new Map(
    [...profiles.keys()].map((profileId) => [
      profileId,
      loadAuthProfileWriteAuthority(params, profileId),
    ]),
  );

  return await withOAuthProfileLocks(
    [...profiles.entries()].flatMap(([profileId, entry]) =>
      entry.credential.type === "oauth" ? [{ profileId, provider: entry.credential.provider }] : [],
    ),
    async () => {
      const currentAuthorities = new Map(
        [...profiles.keys()].map((profileId) => [
          profileId,
          loadAuthProfileWriteAuthority(params, profileId),
        ]),
      );
      const previousProfiles = new Map<string, AuthProfileCredential | undefined>();
      const previousOrder = new Map<string, readonly string[] | undefined>();
      const appliedProfiles = new Map<string, AuthProfileCredential>();
      let storeWasAbsent = false;
      let stateWasAbsent = false;
      const preparedOwner = runAuthProfileWriteTransaction(
        params.agentDir,
        (database, owner) => {
          storeWasAbsent =
            inspectPersistedAuthProfileStoreRaw(params.agentDir, database).status === "missing";
          stateWasAbsent =
            inspectPersistedAuthProfileStateRaw(params.agentDir, database).status === "missing";
          const next =
            loadPersistedAuthProfileStore(params.agentDir, { database }) ??
            ({ version: AUTH_STORE_VERSION, profiles: {} } satisfies AuthProfileStore);
          for (const [profileId, entry] of profiles) {
            if (!entry.replaceExisting && Object.hasOwn(next.profiles, profileId)) {
              continue;
            }
            if (
              supersedesOAuthRefreshGenerationObservedAtAdmission({
                profileId,
                observed: observedProfiles.get(profileId),
                current: currentAuthorities.get(profileId),
                incoming: entry.credential,
                allowOAuthGenerationReplacement: params.allowOAuthGenerationReplacement === true,
              }) ||
              restoresFencedOAuthRefreshGeneration({
                profileId,
                existing: next.profiles[profileId],
                incoming: entry.credential,
              })
            ) {
              throw new Error(
                `Refused to restore fenced OAuth refresh generation for profile "${profileId}".`,
              );
            }
            previousProfiles.set(profileId, next.profiles[profileId]);
            next.profiles[profileId] = entry.credential;
            const existingStats = next.usageStats?.[profileId];
            if (params.resetFailureState && existingStats) {
              next.usageStats![profileId] = resetAuthProfileFailureState(existingStats);
            }
            appliedProfiles.set(profileId, entry.credential);
          }
          for (const [provider, profileIds] of Object.entries(params.order ?? {})) {
            previousOrder.set(provider, next.order?.[provider]);
            const existing = next.order?.[provider] ?? [];
            const additions = [...new Set(profileIds)].filter(
              (profileId) => appliedProfiles.has(profileId) && !existing.includes(profileId),
            );
            if (additions.length > 0) {
              next.order = { ...next.order, [provider]: [...existing, ...additions] };
            }
          }
          if (appliedProfiles.size > 0) {
            saveAuthProfileStoreWithPreparedOwner(
              next,
              params.agentDir,
              { filterExternalAuthProfiles: false, syncExternalCli: false },
              database,
              owner,
            );
          }
          return owner;
        },
        { sharedStoreWrite: true, stateDir: params.stateDir },
      );

      let rollbackResult: AuthProfileBatchRollbackResult | undefined;
      return {
        rollback: () => {
          if (rollbackResult) {
            return rollbackResult;
          }
          const unrevertedProfileIds = new Set<string>();
          runAuthProfileWriteTransaction(
            params.agentDir,
            (database, owner) => {
              if (database.path !== preparedOwner.databasePath) {
                throw new Error("auth profile batch rollback belongs to another owner");
              }
              const current = loadPersistedAuthProfileStore(params.agentDir, { database });
              if (!current) {
                return;
              }
              const ownedProfiles = new Set<string>();
              for (const [profileId, credential] of appliedProfiles) {
                if (!isDeepStrictEqual(current.profiles[profileId], credential)) {
                  unrevertedProfileIds.add(profileId);
                  continue;
                }
                const previous = previousProfiles.get(profileId);
                // Nonportable OAuth generations can be consumed after this batch
                // commits. A delayed rollback must never make one replayable.
                if (previous?.type === "oauth" && previous.copyToAgents !== true) {
                  unrevertedProfileIds.add(profileId);
                  continue;
                }
                ownedProfiles.add(profileId);
                if (previous) {
                  current.profiles[profileId] = previous;
                } else {
                  delete current.profiles[profileId];
                }
              }
              for (const [provider, profileIds] of Object.entries(params.order ?? {})) {
                const existing = current.order?.[provider];
                if (!existing) {
                  continue;
                }
                const preexisting = new Set(previousOrder.get(provider) ?? []);
                const introduced = new Set(
                  profileIds.filter((profileId) => !preexisting.has(profileId)),
                );
                const remaining = existing.filter(
                  (profileId) => !introduced.has(profileId) || !ownedProfiles.has(profileId),
                );
                if (remaining.length === existing.length) {
                  continue;
                }
                if (remaining.length > 0) {
                  current.order = { ...current.order, [provider]: remaining };
                } else if (current.order) {
                  delete current.order[provider];
                  if (Object.keys(current.order).length === 0) {
                    delete current.order;
                  }
                }
              }
              saveAuthProfileStoreWithPreparedOwner(
                current,
                params.agentDir,
                { filterExternalAuthProfiles: false, syncExternalCli: false },
                database,
                owner,
              );
              if (storeWasAbsent && Object.keys(current.profiles).length === 0) {
                deletePersistedAuthProfileStoreRaw(params.agentDir, database);
              }
              if (stateWasAbsent && buildPersistedAuthProfileState(current) === null) {
                writePersistedAuthProfileStateRaw(null, params.agentDir, database);
              }
            },
            { sharedStoreWrite: true, env: preparedOwner.env },
          );
          rollbackResult = { unrevertedProfileIds };
          return rollbackResult;
        },
      };
    },
    { env: resolveAuthProfileWriteEnv(params) },
  );
}

type AuthProfileUpsertParams = {
  profileId: string;
  credential: AuthProfileCredential;
  agentDir?: string;
  stateDir?: string;
};

/** Upserts an auth profile under the store lock, returning null on store write failure. */
export async function upsertAuthProfileWithLock(
  params: AuthProfileUpsertParams,
): Promise<AuthProfileStore | null> {
  const credential = normalizeAuthProfileCredential(params.credential);
  const observed = loadAuthProfileWriteAuthority(params, params.profileId);
  let rejectedFencedGeneration = false;
  const update = async () => {
    const currentAuthority = loadAuthProfileWriteAuthority(params, params.profileId);
    return await updateAuthProfileStoreWithLock({
      agentDir: params.agentDir,
      sharedStoreWrite: true,
      stateDir: params.stateDir,
      saveOptions: {
        filterExternalAuthProfiles: false,
        syncExternalCli: false,
      },
      updater: (store) => {
        if (
          supersedesOAuthRefreshGenerationObservedAtAdmission({
            profileId: params.profileId,
            observed,
            current: currentAuthority,
            incoming: credential,
            allowOAuthGenerationReplacement: false,
          }) ||
          restoresFencedOAuthRefreshGeneration({
            profileId: params.profileId,
            existing: store.profiles[params.profileId],
            incoming: credential,
          })
        ) {
          rejectedFencedGeneration = true;
          return false;
        }
        store.profiles[params.profileId] = credential;
        return true;
      },
    });
  };
  const updated =
    credential.type === "oauth"
      ? await withOAuthProfileLock(
          { profileId: params.profileId, provider: credential.provider },
          update,
          { env: resolveAuthProfileWriteEnv(params) },
        )
      : await update();
  return rejectedFencedGeneration ? null : updated;
}

/** Upserts an auth profile under the store lock, failing when the store cannot be written. */
export async function upsertAuthProfileWithLockOrThrow(
  params: Parameters<typeof upsertAuthProfileWithLock>[0],
): Promise<void> {
  const updated = await upsertAuthProfileWithLock(params);
  if (!updated) {
    throwAuthProfileUpdateError();
  }
}
