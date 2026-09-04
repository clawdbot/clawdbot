/** Canonical owner identity and nonpublishing auth snapshot composition. */
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { resolveOpenClawStateSqlitePath } from "../../state/openclaw-state-db.paths.js";
import { cloneAuthProfileStore } from "./clone.js";
import { AUTH_STORE_VERSION } from "./constants.js";
import {
  assertAuthProfileMigrationCandidates,
  assertAuthProfileMigrationStateAtDatabasePath,
} from "./legacy-source-diagnostic.js";
import {
  resolveLegacyAuthProfileSourceCandidates,
  type LegacyAuthProfileSource,
} from "./legacy-source-files.js";
import { shouldUseMainOwnerForLocalOAuthCredential } from "./ownership.js";
import {
  resolveSharedAuthStoreOwnership,
  resolveSharedAuthStorePath,
  type AuthProfileOwnerScope,
} from "./path-resolve.js";
import {
  loadPersistedAuthProfileStoreAtDatabasePath,
  mergeAuthProfileStores,
} from "./persisted.js";
import { setRuntimeExternalCliProfileIds } from "./runtime-external-profile-references.js";
import { resolveAuthProfileDatabasePath, type AuthProfileStoreOwner } from "./sqlite.js";
import type { AuthProfileStore, RuntimeAuthProfileStore } from "./types.js";

export function createEmptyAuthProfileStore(): AuthProfileStore {
  return { version: AUTH_STORE_VERSION, profiles: {} };
}

export function stripRuntimeExternalProfileMetadata(store: AuthProfileStore): AuthProfileStore {
  const stripped = { ...store };
  delete stripped.runtimeExternalProfileIds;
  delete stripped.runtimeExternalProfileIdsAuthoritative;
  setRuntimeExternalCliProfileIds(stripped, []);
  return stripped;
}

export function markRuntimePersistedProfiles(
  store: AuthProfileStore,
  persistedStore: AuthProfileStore = store,
): AuthProfileStore {
  const profileIds = Object.entries(persistedStore.profiles)
    .flatMap(([profileId, credential]) =>
      isDeepStrictEqual(store.profiles[profileId], credential) ? [profileId] : [],
    )
    .toSorted();
  return {
    ...store,
    runtimePersistedProfileIds: profileIds.length > 0 ? profileIds : undefined,
  };
}

export function setRuntimeLocalProfileMetadata(
  store: AuthProfileStore,
  localProfileIds: Iterable<string>,
  runtimeInheritsMainState = false,
): RuntimeAuthProfileStore {
  return {
    ...store,
    runtimeLocalProfileIds: [...new Set(localProfileIds)].toSorted(),
    ...(runtimeInheritsMainState ? { runtimeInheritsMainState: true } : {}),
  };
}

export function runtimeStoreInheritsMainState(
  store: AuthProfileStore,
  localStore: AuthProfileStore,
): boolean {
  const state = ({ order, lastGood, usageStats }: AuthProfileStore) => ({
    order,
    lastGood,
    usageStats,
  });
  return !isDeepStrictEqual(state(store), state(localStore));
}

export function listRuntimeLocalProfileIds(
  store: RuntimeAuthProfileStore,
  mainStore?: AuthProfileStore,
): string[] {
  if (store.runtimeLocalProfileIds) {
    return store.runtimeLocalProfileIds;
  }
  return Object.entries(store.profiles).flatMap(([profileId, credential]) =>
    mainStore &&
    shouldUseMainOwnerForLocalOAuthCredential({
      local: credential,
      main: mainStore.profiles[profileId],
    })
      ? []
      : [profileId],
  );
}

export function mergeLocalAuthProfileStoreWithInheritedStore(
  localStore: AuthProfileStore,
  inheritedStore: AuthProfileStore,
): RuntimeAuthProfileStore {
  // Preserve local ownership so later publication never retains another owner's inherited rows.
  const merged = mergeAuthProfileStores(inheritedStore, localStore, {
    preserveBaseRuntimeExternalProfiles: true,
  });
  return setRuntimeLocalProfileMetadata(
    stripRuntimeExternalProfileMetadata(merged),
    listRuntimeLocalProfileIds(localStore, inheritedStore),
    runtimeStoreInheritsMainState(merged, localStore),
  );
}

/** Compose the selected durable owner without publishing or discovering an ambient environment. */
export function loadRuntimeAuthProfileOwnerSnapshot(
  owner: AuthProfileStoreOwner,
  options: {
    candidates?: RuntimeAuthProfileLegacyCandidates;
    inheritedStore?: AuthProfileStore;
  } = {},
): RuntimeAuthProfileStore {
  // Only lifecycle clear owns a recorded migration refusal; a committed write cannot bypass it.
  assertAuthProfileMigrationStateAtDatabasePath(owner.databasePath);
  assertAuthProfileMigrationStateAtDatabasePath(owner.sharedDatabasePath);
  const isShared = owner.databasePath === owner.sharedDatabasePath;
  const sharedKind = owner.location === "state-db" ? "shared-state" : "agent";
  const sharedStore = isShared
    ? undefined
    : (options.inheritedStore ??
      markRuntimePersistedProfiles(
        loadPersistedAuthProfileStoreAtDatabasePath(owner.sharedDatabasePath, sharedKind) ??
          createEmptyAuthProfileStore(),
      ));
  if (options.candidates && sharedStore) {
    // Check committed shared facts before a fallible local read can enter publication recovery.
    assertAuthProfileMigrationCandidates({
      databasePath: owner.sharedDatabasePath,
      candidates: options.candidates.shared,
      hasCredentials: () => Object.keys(sharedStore.profiles).length > 0,
    });
  }
  const localStore = markRuntimePersistedProfiles(
    loadPersistedAuthProfileStoreAtDatabasePath(
      owner.databasePath,
      isShared ? sharedKind : "agent",
    ) ?? createEmptyAuthProfileStore(),
  );
  if (options.candidates) {
    assertAuthProfileMigrationCandidates({
      databasePath: owner.databasePath,
      candidates: isShared ? options.candidates.shared : options.candidates.local,
      hasCredentials: () => Object.keys(localStore.profiles).length > 0,
    });
  }
  return sharedStore
    ? mergeLocalAuthProfileStoreWithInheritedStore(localStore, sharedStore)
    : setRuntimeLocalProfileMetadata(localStore, listRuntimeLocalProfileIds(localStore));
}

export type RuntimeAuthProfileLegacyCandidates = {
  local: LegacyAuthProfileSource[];
  shared: LegacyAuthProfileSource[];
};

/** Diagnostic source facts never participate in canonical ownership decisions. */
export function captureRuntimeAuthProfileLegacyCandidates(
  agentDir?: string,
  env: NodeJS.ProcessEnv = process.env,
): RuntimeAuthProfileLegacyCandidates {
  return {
    local: resolveLegacyAuthProfileSourceCandidates({ agentDir, env }),
    shared: resolveLegacyAuthProfileSourceCandidates({ env }),
  };
}

export function cloneRuntimeAuthProfileLegacyCandidates(
  candidates?: RuntimeAuthProfileLegacyCandidates,
): RuntimeAuthProfileLegacyCandidates | undefined {
  return (
    candidates && {
      local: candidates.local.map((source) => ({ ...source })),
      shared: candidates.shared.map((source) => ({ ...source })),
    }
  );
}

/** Core lifecycle receipt; the public SDK snapshot shape intentionally stays unchanged. */
export type OwnedRuntimeAuthProfileStoreSnapshotEntry = {
  databasePath: string;
  agentDir: string;
  store: RuntimeAuthProfileStore;
  owner: RuntimeAuthSharedOwner;
  legacyCandidates?: RuntimeAuthProfileLegacyCandidates;
};

export function prepareRuntimeAuthProfileStoreSnapshots(
  entries: Array<{ databasePath?: string; agentDir?: string; store: AuthProfileStore }>,
  env: NodeJS.ProcessEnv = process.env,
): OwnedRuntimeAuthProfileStoreSnapshotEntry[] {
  if (entries.length === 0) {
    return [];
  }
  const owner = captureRuntimeAuthSharedOwner(env);
  return entries.map((entry) => {
    const databasePath =
      entry.databasePath ??
      (entry.agentDir ? resolveAuthProfileDatabasePath(entry.agentDir) : owner.sharedDatabasePath);
    return {
      databasePath,
      agentDir: path.dirname(databasePath),
      store: cloneAuthProfileStore(entry.store),
      owner: cloneRuntimeAuthSharedOwner(owner),
      legacyCandidates: captureRuntimeAuthProfileLegacyCandidates(
        databasePath === owner.sharedDatabasePath
          ? undefined
          : (entry.agentDir ?? path.dirname(databasePath)),
        env,
      ),
    };
  });
}

export type RuntimeAuthSharedOwner =
  | ({ kind: "resolved" } & Pick<AuthProfileStoreOwner, "sharedDatabasePath" | "location">)
  | { kind: "unresolved"; scope: AuthProfileOwnerScope };

export function cloneRuntimeAuthSharedOwner(owner: RuntimeAuthSharedOwner): RuntimeAuthSharedOwner {
  return owner.kind === "unresolved" ? { ...owner, scope: { ...owner.scope } } : { ...owner };
}

export function captureRuntimeAuthSharedOwner(
  env: NodeJS.ProcessEnv = process.env,
): Extract<RuntimeAuthSharedOwner, { kind: "resolved" }> {
  return {
    kind: "resolved",
    sharedDatabasePath: resolveSharedAuthStorePath(env),
    location: resolveSharedAuthStoreOwnership(env).location,
  };
}

export function runtimeAuthProfileSnapshotSharesOwner(
  snapshot: RuntimeAuthSharedOwner,
  owner: Pick<AuthProfileStoreOwner, "location" | "sharedDatabasePath">,
): boolean {
  if (snapshot.kind === "resolved") {
    return snapshot.sharedDatabasePath === owner.sharedDatabasePath;
  }
  // Resolve forward from captured cold facts and the known producer's storage
  // location; never open the cold scope or infer ownership from directory ancestry.
  const candidate =
    owner.location === "state-db"
      ? resolveOpenClawStateSqlitePath({ OPENCLAW_STATE_DIR: snapshot.scope.stateDir })
      : path.join(snapshot.scope.sharedMainDir, "openclaw-agent.sqlite");
  return candidate === owner.sharedDatabasePath;
}

export function runtimeAuthSharedOwnerRebound(
  previous: RuntimeAuthSharedOwner,
  next: RuntimeAuthSharedOwner,
): boolean {
  return next.kind === "resolved"
    ? !runtimeAuthProfileSnapshotSharesOwner(previous, next)
    : !isDeepStrictEqual(previous, next);
}

export function runtimeAuthCredentialState(
  entries: Iterable<[string, RuntimeAuthProfileStore]>,
): Array<readonly [string, AuthProfileStore["profiles"]]> {
  return Array.from(entries)
    .filter(([, store]) => Object.keys(store.profiles).length > 0)
    .map(([key, store]) => [key, store.profiles] as const)
    .toSorted(([left], [right]) => left.localeCompare(right));
}

export function runtimeAuthOwnerState(
  store: RuntimeAuthProfileStore | undefined,
):
  | Pick<
      RuntimeAuthProfileStore,
      | "order"
      | "profiles"
      | "runtimePersistedProfileIds"
      | "runtimeExternalProfileIds"
      | "runtimeExternalProfileIdsAuthoritative"
      | "runtimeExternalCliProfileIds"
      | "runtimeLocalProfileIds"
      | "runtimeInheritsMainState"
    >
  | undefined {
  if (!store) {
    return undefined;
  }
  return {
    order: store.order,
    profiles: store.profiles,
    runtimePersistedProfileIds: store.runtimePersistedProfileIds,
    runtimeExternalProfileIds: store.runtimeExternalProfileIds,
    runtimeExternalProfileIdsAuthoritative: store.runtimeExternalProfileIdsAuthoritative,
    runtimeExternalCliProfileIds: store.runtimeExternalCliProfileIds,
    runtimeLocalProfileIds: store.runtimeLocalProfileIds,
    runtimeInheritsMainState: store.runtimeInheritsMainState,
  };
}
