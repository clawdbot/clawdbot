/** Locked auth profile writes and attempt-scoped compensation. */
import { isDeepStrictEqual } from "node:util";
import { AUTH_STORE_VERSION } from "./constants.js";
import { normalizeAuthProfileCredential } from "./credential-normalize.js";
import { loadPersistedAuthProfileStore } from "./persisted.js";
import {
  deletePersistedAuthProfileStoreRaw,
  inspectPersistedAuthProfileStateRaw,
  inspectPersistedAuthProfileStoreRaw,
  runAuthProfileWriteTransaction,
  writePersistedAuthProfileStateRaw,
} from "./sqlite.js";
import { buildPersistedAuthProfileState } from "./state.js";
import { saveAuthProfileStoreWithPreparedOwner, updateAuthProfileStoreWithLock } from "./store.js";
import type { AuthProfileCredential, AuthProfileStore } from "./types.js";
import { resetAuthProfileFailureState } from "./usage-state.js";

function throwAuthProfileUpdateError(): never {
  throw new Error(
    "Failed to update auth profile store; the auth store lock may be busy. Wait a moment and retry.",
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
};

/** Atomically persists a batch and returns conditional attempt-scoped compensation. */
export async function persistAuthProfileBatch(
  params: PersistAuthProfileBatchParams,
): Promise<{ rollback: () => void }> {
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
    return { rollback() {} };
  }

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
        previousProfiles.set(profileId, next.profiles[profileId]);
        next.profiles[profileId] = entry.credential;
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

  let rolledBack = false;
  return {
    rollback: () => {
      if (rolledBack) {
        return;
      }
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
              continue;
            }
            ownedProfiles.add(profileId);
            const previous = previousProfiles.get(profileId);
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
      rolledBack = true;
    },
  };
}

type AuthProfileUpsertParams = {
  profileId: string;
  credential: AuthProfileCredential;
  agentDir?: string;
  stateDir?: string;
};

async function upsertAuthProfileWithLockCore(
  params: AuthProfileUpsertParams,
  resetFailureState: boolean,
): Promise<AuthProfileStore | null> {
  const credential = normalizeAuthProfileCredential(params.credential);
  return await updateAuthProfileStoreWithLock({
    agentDir: params.agentDir,
    sharedStoreWrite: true,
    stateDir: params.stateDir,
    saveOptions: {
      filterExternalAuthProfiles: false,
      syncExternalCli: false,
    },
    updater: (store) => {
      store.profiles[params.profileId] = credential;
      const existingStats = store.usageStats?.[params.profileId];
      if (resetFailureState && existingStats) {
        store.usageStats![params.profileId] = resetAuthProfileFailureState(existingStats);
      }
      return true;
    },
  });
}

/** Upserts an auth profile under the store lock, returning null on store write failure. */
export async function upsertAuthProfileWithLock(
  params: AuthProfileUpsertParams,
): Promise<AuthProfileStore | null> {
  return await upsertAuthProfileWithLockCore(params, false);
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

/** Replaces one completed-login credential and clears only its existing failure state. */
export async function upsertAuthProfileAfterLoginWithLockOrThrow(
  params: AuthProfileUpsertParams,
): Promise<void> {
  const updated = await upsertAuthProfileWithLockCore(params, true);
  if (!updated) {
    throwAuthProfileUpdateError();
  }
}
