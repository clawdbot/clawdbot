import { createHash } from "node:crypto";
import path from "node:path";
import { persistAuthProfileBatch } from "../agents/auth-profiles.js";
import { OAUTH_REFRESH_LOCK_OPTIONS } from "../agents/auth-profiles/constants.js";
import { resolveStateDir } from "../config/paths.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { isValidEnvSecretRefId, type SecretRef } from "../config/types.secrets.js";
import { toErrorObject } from "../infra/errors.js";
import { acquireFileLock, type FileLockHandle } from "../infra/file-lock.js";
import { registerSecretValueForRedaction } from "../logging/secret-redaction-registry.js";
import { resolveDefaultSecretProviderAlias } from "../secrets/ref-contract.js";
import { writeSecretStoreEntryWithRollback } from "../secrets/store/secret-store.js";
import type { ProviderAuthProfile } from "./provider-authentication.types.js";

const STORE_SCOPE = { kind: "team" } as const;
const STORE_NAME_DIGEST_LENGTH = 24;
const PROVIDER_AUTH_LOCK_OPTIONS = {
  ...OAUTH_REFRESH_LOCK_OPTIONS,
  staleRecovery: "fail-closed",
} as const;

type StoreRollback = {
  profileId: string;
  rollback: () => boolean;
};

export type ProviderAuthPersistenceReceipt = {
  profiles: ProviderAuthProfile[];
  commit: () => Promise<void>;
  rollback: () => Promise<void>;
};

type PersistProviderAuthProfileBatchParams = Omit<
  Parameters<typeof persistAuthProfileBatch>[0],
  "profiles" | "resetFailureState"
> & {
  profiles: readonly ProviderAuthProfile[];
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
};

export type ProviderAuthProtectedProfilesReceipt = {
  profiles: ProviderAuthProfile[];
  commit: () => Promise<void>;
  rollback: (retainProfileIds?: ReadonlySet<string>) => Promise<void>;
};

function resolveProfileDigest(profile: ProviderAuthProfile): string {
  return createHash("sha256")
    .update(profile.credential.provider)
    .update("\0")
    .update(profile.profileId)
    .digest("hex");
}

function resolveStoreName(profile: ProviderAuthProfile): string {
  const storage = profile.secretStorage;
  if (!storage) {
    throw new Error("Provider auth profile does not request protected secret storage.");
  }
  const namePrefix = storage.namePrefix.trim();
  // Stable per final profile so relogin replaces one owned entry instead of accumulating
  // secrets; provider identity prevents different owners from sharing that entry.
  const digest = resolveProfileDigest(profile).slice(0, STORE_NAME_DIGEST_LENGTH).toUpperCase();
  const name = `${namePrefix}_${digest}`;
  if (!isValidEnvSecretRefId(name)) {
    throw new Error(
      "Provider auth secret-store name prefix must produce a valid environment-style name.",
    );
  }
  return name;
}

function buildStoredCredential(profile: ProviderAuthProfile, ref: SecretRef) {
  const credential = profile.credential;
  if (credential.type === "token" && typeof credential.token === "string") {
    const { token: _token, ...withoutToken } = credential;
    return { ...withoutToken, tokenRef: ref };
  }
  if (credential.type === "api_key" && typeof credential.key === "string") {
    const { key: _key, ...withoutKey } = credential;
    return { ...withoutKey, keyRef: ref };
  }
  throw new Error(
    `Provider auth profile "${profile.profileId}" requested protected storage without an inline static credential.`,
  );
}

function rollbackStoreWrites(
  writes: readonly StoreRollback[],
  retainProfileIds: ReadonlySet<string>,
): void {
  const errors: unknown[] = [];
  for (const write of writes.toReversed()) {
    if (retainProfileIds.has(write.profileId)) {
      continue;
    }
    try {
      if (!write.rollback()) {
        errors.push(
          new Error(
            `Protected credential rollback lost ownership for profile "${write.profileId}".`,
          ),
        );
      }
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(
      errors,
      "Could not confirm rollback of protected provider credentials; run openclaw doctor --fix before retrying.",
    );
  }
}

function materializeProviderAuthProfiles(params: {
  profiles: readonly ProviderAuthProfile[];
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
}): {
  profiles: ProviderAuthProfile[];
  rollback: (retainProfileIds?: ReadonlySet<string>) => void;
} {
  const database = { env: params.env };
  const writes: StoreRollback[] = [];
  let outcome: "pending" | "rolled-back" | "rollback-failed" = "pending";
  let rollbackFailure: Error | undefined;
  const rollback = (retainProfileIds: ReadonlySet<string> = new Set()) => {
    if (outcome === "rolled-back") {
      return;
    }
    if (outcome === "rollback-failed") {
      if (rollbackFailure) {
        throw rollbackFailure;
      }
      throw new Error("Provider auth rollback failed without a recorded error.");
    }
    try {
      rollbackStoreWrites(writes, retainProfileIds);
      outcome = "rolled-back";
    } catch (error) {
      rollbackFailure = toErrorObject(error, "Protected credential rollback failed");
      outcome = "rollback-failed";
      throw rollbackFailure;
    }
  };

  try {
    const profiles = params.profiles.map((profile): ProviderAuthProfile => {
      if (!profile.secretStorage) {
        return profile;
      }
      const name = resolveStoreName(profile);
      const credential = profile.credential;
      const value =
        credential.type === "token"
          ? credential.token
          : credential.type === "api_key"
            ? credential.key
            : undefined;
      if (typeof value !== "string") {
        throw new Error(
          `Provider auth profile "${profile.profileId}" requested protected storage without an inline static credential.`,
        );
      }
      registerSecretValueForRedaction(value);
      let write: ReturnType<typeof writeSecretStoreEntryWithRollback>;
      try {
        write = writeSecretStoreEntryWithRollback({
          scope: STORE_SCOPE,
          name,
          value,
          kind: "secret",
          updatedBy: "provider-auth",
          database,
        });
      } catch (error) {
        throw new Error(
          "Could not write the protected secret store. Check the OpenClaw state-directory permissions and retry; the auth profile was not changed.",
          { cause: error },
        );
      }
      writes.push({ profileId: profile.profileId, rollback: write.rollback });
      const ref: SecretRef = {
        source: "store",
        provider: resolveDefaultSecretProviderAlias(params.config, "store", {
          preferFirstProviderForSource: true,
        }),
        id: name,
      };
      const { secretStorage: _secretStorage, ...persistentProfile } = profile;
      return {
        ...persistentProfile,
        credential: buildStoredCredential(profile, ref),
      };
    });
    return { profiles, rollback };
  } catch (error) {
    try {
      rollback();
    } catch (rollbackError) {
      // oxlint-disable-next-line preserve-caught-error -- AggregateError.errors retains rollbackError; cause remains the initiating persistence failure.
      throw new AggregateError(
        [error, rollbackError],
        "Provider credential persistence failed and protected-store rollback could not be confirmed.",
        { cause: error },
      );
    }
    throw error;
  }
}

function resolvePersistenceEnv(params: {
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
}): NodeJS.ProcessEnv {
  return params.stateDir
    ? { ...(params.env ?? process.env), OPENCLAW_STATE_DIR: params.stateDir }
    : (params.env ?? process.env);
}

async function acquireProviderAuthLocks(
  profiles: readonly ProviderAuthProfile[],
  env: NodeJS.ProcessEnv,
): Promise<FileLockHandle[]> {
  const lockTargets = [
    ...new Map(
      profiles.map(
        (profile) =>
          [
            `${profile.credential.provider}\0${profile.profileId}`,
            path.join(
              resolveStateDir(env),
              "locks",
              "provider-auth-persistence",
              `lock-${resolveProfileDigest(profile)}`,
            ),
          ] as const,
      ),
    ).values(),
  ].toSorted((left, right) => left.localeCompare(right));
  const locks: FileLockHandle[] = [];
  try {
    for (const target of lockTargets) {
      locks.push(await acquireFileLock(target, PROVIDER_AUTH_LOCK_OPTIONS));
    }
    return locks;
  } catch (error) {
    const releaseErrors: unknown[] = [];
    for (const lock of locks.toReversed()) {
      try {
        await lock.release();
      } catch (releaseError) {
        releaseErrors.push(releaseError);
      }
    }
    if (releaseErrors.length > 0) {
      throw new AggregateError(
        [error, ...releaseErrors],
        "Provider auth lock acquisition failed and acquired locks could not all be released.",
        { cause: error },
      );
    }
    throw error;
  }
}

async function releaseProviderAuthLocks(locks: readonly FileLockHandle[]): Promise<void> {
  const errors: unknown[] = [];
  for (const lock of locks.toReversed()) {
    try {
      await lock.release();
    } catch (error) {
      errors.push(error);
    }
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, "Provider auth persistence locks could not all be released.");
  }
}

async function throwAfterStageFailure(params: {
  error: unknown;
  locks: readonly FileLockHandle[];
}): Promise<never> {
  const errors = [params.error];
  try {
    await releaseProviderAuthLocks(params.locks);
  } catch (error) {
    errors.push(error);
  }
  if (errors.length > 1) {
    throw new AggregateError(
      errors,
      "Provider auth persistence failed and staged state could not be fully released.",
      { cause: params.error },
    );
  }
  throw params.error;
}

/** Stages protected provider credentials while retaining their per-profile writer locks. */
export async function stageProviderAuthProfilesForPersistence(params: {
  profiles: readonly ProviderAuthProfile[];
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  stateDir?: string;
}): Promise<ProviderAuthProtectedProfilesReceipt> {
  const env = resolvePersistenceEnv(params);
  const locks = await acquireProviderAuthLocks(params.profiles, env);
  let prepared: ReturnType<typeof materializeProviderAuthProfiles>;
  try {
    prepared = materializeProviderAuthProfiles({
      profiles: params.profiles,
      config: params.config,
      env,
    });
  } catch (error) {
    return await throwAfterStageFailure({ error, locks });
  }

  let outcome: "pending" | "committed" | "rolled-back" | "rollback-failed" = "pending";
  let rollbackFailure: Error | undefined;
  let released = false;
  let releaseFailure: Error | undefined;
  const release = async () => {
    if (released) {
      if (releaseFailure) {
        throw releaseFailure;
      }
      return;
    }
    released = true;
    try {
      await releaseProviderAuthLocks(locks);
    } catch (error) {
      releaseFailure = toErrorObject(error, "Provider auth persistence lock release failed");
      throw releaseFailure;
    }
  };
  return {
    profiles: prepared.profiles,
    commit: async () => {
      if (outcome === "rolled-back") {
        throw new Error("Cannot commit rolled-back provider auth persistence.");
      }
      if (outcome === "rollback-failed") {
        throw new Error("Cannot commit provider auth persistence after rollback failed.");
      }
      outcome = "committed";
      await release();
    },
    rollback: async (retainProfileIds = new Set()) => {
      if (outcome === "committed") {
        await release();
        return;
      }
      if (outcome === "rollback-failed") {
        if (rollbackFailure) {
          throw rollbackFailure;
        }
        throw new Error("Provider auth rollback failed without a recorded error.");
      }
      if (outcome === "pending") {
        let rollbackError: unknown;
        try {
          prepared.rollback(retainProfileIds);
        } catch (error) {
          rollbackError = error;
        }
        let releaseError: unknown;
        try {
          await release();
        } catch (error) {
          releaseError = error;
        }
        if (rollbackError || releaseError) {
          rollbackFailure =
            rollbackError && releaseError
              ? new AggregateError(
                  [rollbackError, releaseError],
                  "Protected provider auth rollback failed and its locks could not all be released.",
                  { cause: rollbackError },
                )
              : toErrorObject(
                  rollbackError ?? releaseError,
                  "Protected provider auth rollback failed",
                );
          outcome = "rollback-failed";
          throw rollbackFailure;
        }
        outcome = "rolled-back";
        return;
      }
      await release();
    },
  };
}

async function stageProviderAuthProfileBatchCore(
  params: PersistProviderAuthProfileBatchParams & { resetFailureState?: boolean },
): Promise<ProviderAuthPersistenceReceipt> {
  const prepared = await stageProviderAuthProfilesForPersistence(params);
  let persisted: Awaited<ReturnType<typeof persistAuthProfileBatch>>;
  try {
    persisted = await persistAuthProfileBatch({
      profiles: prepared.profiles,
      ...(params.order ? { order: params.order } : {}),
      ...(params.agentDir ? { agentDir: params.agentDir } : {}),
      ...(params.stateDir ? { stateDir: params.stateDir } : {}),
      ...(params.resetFailureState ? { resetFailureState: true } : {}),
      allowOAuthGenerationReplacement: true,
    });
  } catch (error) {
    try {
      await prepared.rollback();
    } catch (rollbackError) {
      // oxlint-disable-next-line preserve-caught-error -- AggregateError.errors retains rollbackError; cause remains the initiating persistence failure.
      throw new AggregateError(
        [error, rollbackError],
        "Provider auth persistence failed and staged state could not be fully released.",
        { cause: error },
      );
    }
    throw error;
  }

  let outcome: "pending" | "committed" | "rolled-back" | "rollback-failed" = "pending";
  let rollbackFailure: Error | undefined;
  return {
    profiles: prepared.profiles,
    commit: async () => {
      if (outcome === "rolled-back") {
        throw new Error("Cannot commit rolled-back provider auth persistence.");
      }
      if (outcome === "rollback-failed") {
        throw new Error("Cannot commit provider auth persistence after rollback failed.");
      }
      outcome = "committed";
      await prepared.commit();
    },
    rollback: async () => {
      if (outcome === "committed") {
        await prepared.commit();
        return;
      }
      if (outcome === "rollback-failed") {
        if (rollbackFailure) {
          throw rollbackFailure;
        }
        throw new Error("Provider auth rollback failed without a recorded error.");
      }
      if (outcome === "pending") {
        let profileRollbackError: unknown;
        let rollbackResult: ReturnType<typeof persisted.rollback> | undefined;
        try {
          rollbackResult = persisted.rollback();
        } catch (error) {
          profileRollbackError = error;
        }
        let protectedRollbackError: unknown;
        try {
          if (rollbackResult) {
            await prepared.rollback(rollbackResult.unrevertedProfileIds);
          } else {
            await prepared.commit();
          }
        } catch (error) {
          protectedRollbackError = error;
        }
        if (profileRollbackError && protectedRollbackError) {
          rollbackFailure = new AggregateError(
            [profileRollbackError, protectedRollbackError],
            "Provider auth profile rollback failed and its protected persistence could not be released.",
            { cause: profileRollbackError },
          );
        } else {
          const failure = profileRollbackError ?? protectedRollbackError;
          rollbackFailure = failure
            ? toErrorObject(failure, "Provider auth rollback failed")
            : undefined;
        }
        if (rollbackFailure) {
          outcome = "rollback-failed";
          throw rollbackFailure;
        }
        outcome = "rolled-back";
        return;
      }
      await prepared.rollback();
    },
  };
}

/** Stages provider auth until its owning config publication commits or rolls back. */
export async function stageProviderAuthProfileBatch(
  params: PersistProviderAuthProfileBatchParams,
): Promise<ProviderAuthPersistenceReceipt> {
  return await stageProviderAuthProfileBatchCore(params);
}

/** Persists provider auth with no later config-coupled rollback boundary. */
export async function persistProviderAuthProfileBatch(
  params: PersistProviderAuthProfileBatchParams,
): Promise<ProviderAuthProfile[]> {
  const staged = await stageProviderAuthProfileBatchCore(params);
  await staged.commit();
  return staged.profiles;
}

/** Commits completed login credentials and clears only those profiles' failure state. */
export async function persistProviderAuthProfilesAfterLogin(
  params: PersistProviderAuthProfileBatchParams,
): Promise<ProviderAuthProfile[]> {
  const staged = await stageProviderAuthProfileBatchCore({
    ...params,
    resetFailureState: true,
  });
  await staged.commit();
  return staged.profiles;
}
