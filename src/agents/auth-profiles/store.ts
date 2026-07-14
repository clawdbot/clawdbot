/**
 * Auth profile store orchestration.
 * Merges persisted stores, runtime snapshots, inherited main-agent OAuth
 * profiles, and external CLI overlays while keeping save paths local.
 */
import { isDeepStrictEqual } from "node:util";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { isSecretRef } from "../../config/types.secrets.js";
import { asDateTimestampMs } from "../../shared/number-coercion.js";
import {
  deferOpenClawAgentPostCommitPublication,
  type OpenClawAgentDatabase,
} from "../../state/openclaw-agent-db.js";
import { isRecord } from "../../utils.js";
import { cloneAuthProfileStore } from "./clone.js";
import { AUTH_STORE_VERSION, log } from "./constants.js";
import {
  listRuntimeExternalAuthProfiles,
  overlayExternalAuthProfiles,
  syncPersistedExternalCliAuthProfiles,
} from "./external-auth.js";
import type { ExternalCliAuthDiscovery } from "./external-cli-discovery.js";
import {
  isSafeToAdoptMainStoreOAuthIdentity,
  shouldPersistRuntimeExternalOAuthProfile,
  type RuntimeExternalOAuthProfile,
} from "./oauth-shared.js";
import { resolveAuthStorePath } from "./paths.js";
import {
  buildPersistedAuthProfileSecretsStore,
  loadPersistedAuthProfileStore,
  mergeAuthProfileStores,
  mergeOAuthFileIntoStore,
} from "./persisted.js";
import {
  clearRuntimeAuthProfileStoreSnapshot as clearRuntimeAuthProfileStoreSnapshotImpl,
  clearRuntimeAuthProfileStoreSnapshots as clearRuntimeAuthProfileStoreSnapshotsImpl,
  getRuntimeAuthProfileStoreSnapshot as getRuntimeAuthProfileStoreSnapshotImpl,
  getRuntimeAuthProfileStoreSnapshotRevision,
  noteRuntimeAuthProfileStorePersistedMutation,
  listRuntimeAuthProfileStoreSnapshots,
  replaceRuntimeAuthProfileStoreSnapshots as replaceRuntimeAuthProfileStoreSnapshotsImpl,
  setRuntimeAuthProfileStoreSnapshot,
} from "./runtime-snapshots.js";
import {
  deletePersistedAuthProfileStoreRaw,
  readPersistedAuthProfileStoreRaw,
  readPersistedAuthProfileStateRaw,
  runAuthProfileWriteTransaction,
  writePersistedAuthProfileStateRaw,
  writePersistedAuthProfileStoreRaw,
} from "./sqlite.js";
import { buildPersistedAuthProfileState, loadPersistedAuthProfileState } from "./state.js";
import type { AuthProfileStore, RuntimeAuthProfileStore } from "./types.js";

type LoadAuthProfileStoreOptions = {
  allowKeychainPrompt?: boolean;
  config?: OpenClawConfig;
  database?: OpenClawAgentDatabase;
  externalCli?: ExternalCliAuthDiscovery;
  readOnly?: boolean;
  syncExternalCli?: boolean;
  externalCliProviderIds?: Iterable<string>;
  externalCliProfileIds?: Iterable<string>;
};

type SaveAuthProfileStoreOptions = {
  filterExternalAuthProfiles?: boolean;
  preserveOrderProfileIds?: Iterable<string>;
  preserveStateProfileIds?: Iterable<string>;
  pruneOrderProfileIds?: Iterable<string>;
  syncExternalCli?: boolean;
};

const INLINE_OAUTH_TOKEN_FIELDS = ["access", "refresh", "idToken"] as const;

function hasInlineOAuthTokenMaterial(credential: Record<string, unknown>): boolean {
  return INLINE_OAUTH_TOKEN_FIELDS.some((field) => credential[field] !== undefined);
}

function hasChangedInlineOAuthTokenMaterial(params: {
  credential: Record<string, unknown>;
  existingCredential: Record<string, unknown>;
}): boolean {
  return INLINE_OAUTH_TOKEN_FIELDS.some((field) => {
    if (params.credential[field] === undefined) {
      return false;
    }
    return !isDeepStrictEqual(params.credential[field], params.existingCredential[field]);
  });
}

function preserveLegacyOAuthRefsOnSave(params: {
  payload: ReturnType<typeof buildPersistedAuthProfileSecretsStore>;
  existingRaw: unknown;
}): ReturnType<typeof buildPersistedAuthProfileSecretsStore> {
  if (!isRecord(params.existingRaw) || !isRecord(params.existingRaw.profiles)) {
    return params.payload;
  }
  let nextProfiles: typeof params.payload.profiles | undefined;
  for (const [profileId, credential] of Object.entries(
    params.payload.profiles as Record<string, unknown>,
  )) {
    if (!isRecord(credential) || credential.oauthRef !== undefined || credential.type !== "oauth") {
      continue;
    }
    const existingCredential = params.existingRaw.profiles[profileId];
    if (
      !isRecord(existingCredential) ||
      existingCredential.oauthRef === undefined ||
      existingCredential.type !== "oauth"
    ) {
      continue;
    }
    if (
      hasInlineOAuthTokenMaterial(credential) &&
      hasChangedInlineOAuthTokenMaterial({ credential, existingCredential })
    ) {
      continue;
    }
    // Preserve legacy oauthRef ownership when current save data did not replace
    // inline OAuth material; otherwise older credential references would be lost.
    nextProfiles ??= { ...params.payload.profiles };
    nextProfiles[profileId] = {
      ...credential,
      oauthRef: existingCredential.oauthRef,
    } as unknown as (typeof nextProfiles)[string];
  }
  return nextProfiles ? { ...params.payload, profiles: nextProfiles } : params.payload;
}

type ResolvedExternalCliOverlayOptions = {
  allowKeychainPrompt?: boolean;
  config?: OpenClawConfig;
  externalCliProviderIds?: Iterable<string>;
  externalCliProfileIds?: Iterable<string>;
};

type ExternalCliSyncResult = {
  store: AuthProfileStore;
  cacheable: boolean;
};

let runtimeSnapshotPublisherForTest: ((publish: () => void) => void) | undefined;

function publishRuntimeSnapshotsAfterCommit(publish: (() => void) | undefined): boolean {
  if (!publish) {
    return true;
  }
  try {
    if (runtimeSnapshotPublisherForTest) {
      runtimeSnapshotPublisherForTest(publish);
    } else {
      publish();
    }
    return true;
  } catch (err) {
    clearRuntimeAuthProfileStoreSnapshotsImpl();
    log.warn("auth profile store committed but runtime snapshot publication failed", { err });
    return false;
  }
}

export const testing = {
  publishRuntimeSnapshotsAfterCommit,
  resetRuntimeSnapshotPublisherForTest(): void {
    runtimeSnapshotPublisherForTest = undefined;
  },
  setRuntimeSnapshotPublisherForTest(publisher: (publish: () => void) => void): void {
    runtimeSnapshotPublisherForTest = publisher;
  },
};

function resolvePersistedLoadOptions(
  options: Pick<LoadAuthProfileStoreOptions, "allowKeychainPrompt" | "database"> | undefined,
): { allowKeychainPrompt?: boolean; database?: OpenClawAgentDatabase } {
  return {
    ...(options?.allowKeychainPrompt !== undefined
      ? { allowKeychainPrompt: options.allowKeychainPrompt }
      : {}),
    ...(options?.database ? { database: options.database } : {}),
  };
}

function isInheritedMainOAuthCredential(params: {
  agentDir?: string;
  profileId: string;
  credential: AuthProfileStore["profiles"][string];
}): boolean {
  if (!params.agentDir || params.credential.type !== "oauth") {
    return false;
  }
  const authPath = resolveAuthStorePath(params.agentDir);
  const mainAuthPath = resolveAuthStorePath();
  if (authPath === mainAuthPath) {
    return false;
  }

  const localStore = loadPersistedAuthProfileStore(params.agentDir);
  if (localStore?.profiles[params.profileId]) {
    return false;
  }

  // Local agent stores can inherit main OAuth credentials. Do not persist the
  // inherited copy unless the local store actually owns or improves it.
  const mainCredential = loadPersistedAuthProfileStore()?.profiles[params.profileId];
  return (
    mainCredential?.type === "oauth" &&
    (isDeepStrictEqual(mainCredential, params.credential) ||
      shouldUseMainOwnerForLocalOAuthCredential({
        local: params.credential,
        main: mainCredential,
      }))
  );
}

function shouldUseMainOwnerForLocalOAuthCredential(params: {
  local: AuthProfileStore["profiles"][string];
  main: AuthProfileStore["profiles"][string] | undefined;
}): boolean {
  if (params.local.type !== "oauth" || params.main?.type !== "oauth") {
    return false;
  }
  if (!isSafeToAdoptMainStoreOAuthIdentity(params.local, params.main)) {
    return false;
  }
  if (isDeepStrictEqual(params.local, params.main)) {
    return true;
  }
  const mainExpires = asDateTimestampMs(params.main.expires);
  if (mainExpires === undefined) {
    return false;
  }
  const localExpires = asDateTimestampMs(params.local.expires);
  return localExpires === undefined || mainExpires >= localExpires;
}

function resolveRuntimeAuthProfileStore(
  agentDir?: string,
  options?: Pick<LoadAuthProfileStoreOptions, "allowKeychainPrompt">,
): AuthProfileStore | null {
  const mainKey = resolveAuthStorePath(undefined);
  const requestedKey = resolveAuthStorePath(agentDir);
  const mainStore = getRuntimeAuthProfileStoreSnapshotImpl(undefined);
  const requestedStore = getRuntimeAuthProfileStoreSnapshotImpl(agentDir);

  if (!agentDir || requestedKey === mainKey) {
    if (!mainStore) {
      return null;
    }
    return mainStore;
  }

  if (mainStore && requestedStore) {
    return mergeAuthProfileStores(mainStore, requestedStore, {
      preserveBaseRuntimeExternalProfiles: true,
    });
  }
  if (requestedStore) {
    const persistedMainStore = loadAuthProfileStoreForAgent(undefined, {
      readOnly: true,
      syncExternalCli: false,
      ...resolvePersistedLoadOptions(options),
    });
    return mergeAuthProfileStores(persistedMainStore, requestedStore, {
      preserveBaseRuntimeExternalProfiles: true,
    });
  }
  if (mainStore) {
    const persistedRequestedStore = loadAuthProfileStoreForAgent(agentDir, {
      readOnly: true,
      syncExternalCli: false,
      ...resolvePersistedLoadOptions(options),
    });
    return mergeAuthProfileStores(mainStore, persistedRequestedStore, {
      preserveBaseRuntimeExternalProfiles: true,
    });
  }

  return null;
}

function resolveExternalCliOverlayOptions(
  options: LoadAuthProfileStoreOptions | undefined,
): ResolvedExternalCliOverlayOptions {
  const discovery = options?.externalCli;
  if (!discovery) {
    return {
      ...(options?.allowKeychainPrompt !== undefined
        ? { allowKeychainPrompt: options.allowKeychainPrompt }
        : {}),
      ...(options?.config ? { config: options.config } : {}),
      ...(options?.externalCliProviderIds
        ? { externalCliProviderIds: options.externalCliProviderIds }
        : {}),
      ...(options?.externalCliProfileIds
        ? { externalCliProfileIds: options.externalCliProfileIds }
        : {}),
    };
  }
  if (discovery.mode === "none") {
    const config = discovery.config ?? options?.config;
    return {
      allowKeychainPrompt: false,
      ...(config ? { config } : {}),
      externalCliProviderIds: [],
      externalCliProfileIds: [],
    };
  }
  if (discovery.mode === "existing") {
    const allowKeychainPrompt = discovery.allowKeychainPrompt ?? options?.allowKeychainPrompt;
    const config = discovery.config ?? options?.config;
    return {
      ...(allowKeychainPrompt !== undefined ? { allowKeychainPrompt } : {}),
      ...(config ? { config } : {}),
    };
  }
  const allowKeychainPrompt = discovery.allowKeychainPrompt ?? options?.allowKeychainPrompt;
  const config = discovery.config ?? options?.config;
  return {
    ...(allowKeychainPrompt !== undefined ? { allowKeychainPrompt } : {}),
    ...(config ? { config } : {}),
    ...(discovery.providerIds ? { externalCliProviderIds: discovery.providerIds } : {}),
    ...(discovery.profileIds ? { externalCliProfileIds: discovery.profileIds } : {}),
  };
}

function hasScopedExternalCliOverlay(options: ResolvedExternalCliOverlayOptions): boolean {
  return (
    options.externalCliProviderIds !== undefined || options.externalCliProfileIds !== undefined
  );
}

function maybeSyncPersistedExternalCliAuthProfiles(params: {
  store: AuthProfileStore;
  agentDir?: string;
  options?: LoadAuthProfileStoreOptions;
}): ExternalCliSyncResult {
  if (
    params.options?.readOnly === true ||
    params.options?.syncExternalCli === false ||
    process.env.OPENCLAW_AUTH_STORE_READONLY === "1"
  ) {
    return { store: params.store, cacheable: true };
  }
  const synced = syncPersistedExternalCliAuthProfiles(params.store, {
    agentDir: params.agentDir,
    ...resolveExternalCliOverlayOptions(params.options),
  });
  if (synced === params.store) {
    return { store: params.store, cacheable: true };
  }
  const changedProfiles = Object.entries(synced.profiles).filter(([profileId, credential]) => {
    const previous = params.store.profiles[profileId];
    return !isDeepStrictEqual(previous, credential);
  });
  if (changedProfiles.length === 0) {
    return { store: synced, cacheable: true };
  }

  // External CLI sync writes only profiles that still match the loaded
  // baseline, avoiding overwrite of concurrent local auth changes.
  let publishRuntimeSnapshots: (() => void) | undefined;
  let result: ExternalCliSyncResult;
  try {
    result = runAuthProfileWriteTransaction(params.agentDir, (database) => {
      const latestStore = loadPersistedAuthProfileStore(params.agentDir, {
        ...resolvePersistedLoadOptions(params.options),
        database,
      }) ?? {
        version: AUTH_STORE_VERSION,
        profiles: {},
      };
      let changed = false;
      for (const [profileId, credential] of changedProfiles) {
        const previous = params.store.profiles[profileId];
        const latest = latestStore.profiles[profileId];
        if (!isDeepStrictEqual(latest, previous)) {
          log.debug("skipped persisted external cli auth sync for concurrently changed profile", {
            profileId,
          });
          continue;
        }
        latestStore.profiles[profileId] = credential;
        changed = true;
      }
      if (changed) {
        publishRuntimeSnapshots = saveAuthProfileStoreInTransaction(
          latestStore,
          params.agentDir,
          {
            filterExternalAuthProfiles: false,
          },
          database,
        );
      }
      return { store: latestStore, cacheable: true };
    });
  } catch (err) {
    log.warn("skipped persisted external cli auth sync because auth store write failed", {
      err,
    });
    return { store: params.store, cacheable: false };
  }
  return publishRuntimeSnapshotsAfterCommit(publishRuntimeSnapshots)
    ? result
    : { store: result.store, cacheable: false };
}

function shouldKeepProfileInLocalStore(params: {
  store: AuthProfileStore;
  profileId: string;
  credential: AuthProfileStore["profiles"][string];
  agentDir?: string;
  options?: SaveAuthProfileStoreOptions;
  externalProfiles: () => RuntimeExternalOAuthProfile[];
}): boolean {
  if (params.credential.type !== "oauth") {
    return true;
  }
  if (
    isInheritedMainOAuthCredential({
      agentDir: params.agentDir,
      profileId: params.profileId,
      credential: params.credential,
    })
  ) {
    return false;
  }
  if (params.options?.filterExternalAuthProfiles === false) {
    return true;
  }
  if (params.store.runtimeExternalProfileIds?.includes(params.profileId)) {
    // Runtime external profiles are normally overlays. Persist only when they
    // have explicit local state or differ from the runtime snapshot.
    const persistedCredential = loadPersistedAuthProfileStore(params.agentDir)?.profiles[
      params.profileId
    ];
    if (persistedCredential) {
      return shouldPersistRuntimeExternalOAuthProfile({
        profileId: params.profileId,
        credential: params.credential,
        profiles: params.externalProfiles(),
      });
    }
    const runtimeCredential = getRuntimeAuthProfileStoreSnapshot(params.agentDir)?.profiles[
      params.profileId
    ];
    if (!runtimeCredential || isDeepStrictEqual(runtimeCredential, params.credential)) {
      return false;
    }
  }
  return shouldPersistRuntimeExternalOAuthProfile({
    profileId: params.profileId,
    credential: params.credential,
    profiles: params.externalProfiles(),
  });
}

function pruneAuthProfileStoreReferences(
  store: RuntimeAuthProfileStore,
  keptProfileIds: Set<string>,
  keptOrderProfileIds = keptProfileIds,
): void {
  store.order = store.order
    ? Object.fromEntries(
        Object.entries(store.order)
          .map(([provider, profileIds]) => [
            provider,
            profileIds.filter((profileId) => keptOrderProfileIds.has(profileId)),
          ])
          .filter(([, profileIds]) => Array.isArray(profileIds) && profileIds.length > 0),
      )
    : undefined;
  store.lastGood = store.lastGood
    ? Object.fromEntries(
        Object.entries(store.lastGood).filter(([, profileId]) => keptProfileIds.has(profileId)),
      )
    : undefined;
  store.usageStats = store.usageStats
    ? Object.fromEntries(
        Object.entries(store.usageStats).filter(([profileId]) => keptProfileIds.has(profileId)),
      )
    : undefined;
  store.runtimePersistedProfileIds = store.runtimePersistedProfileIds
    ?.filter((profileId) => keptProfileIds.has(profileId))
    .toSorted();
  if (store.runtimePersistedProfileIds?.length === 0) {
    store.runtimePersistedProfileIds = undefined;
  }
  store.runtimeLocalProfileIds = store.runtimeLocalProfileIds
    ?.filter((profileId) => keptProfileIds.has(profileId))
    .toSorted();
  store.runtimeExternalProfileIds = store.runtimeExternalProfileIds
    ?.filter((profileId) => keptProfileIds.has(profileId))
    .toSorted();
  if (
    store.runtimeExternalProfileIds?.length === 0 &&
    store.runtimeExternalProfileIdsAuthoritative !== true
  ) {
    store.runtimeExternalProfileIds = undefined;
  }
  if (store.runtimeExternalProfileIdsAuthoritative === true) {
    store.runtimeExternalProfileIds ??= [];
  }
}

function buildLocalAuthProfileStoreForSave(params: {
  store: AuthProfileStore;
  agentDir?: string;
  options?: SaveAuthProfileStoreOptions;
}): AuthProfileStore {
  const localStore = cloneAuthProfileStore(params.store);
  let externalProfiles: RuntimeExternalOAuthProfile[] | undefined;
  const getExternalProfiles = (): RuntimeExternalOAuthProfile[] =>
    (externalProfiles ??= listRuntimeExternalAuthProfiles({
      store: params.store,
      agentDir: params.agentDir,
    }));
  localStore.profiles = Object.fromEntries(
    Object.entries(localStore.profiles).filter(([profileId, credential]) =>
      shouldKeepProfileInLocalStore({
        store: params.store,
        profileId,
        credential,
        agentDir: params.agentDir,
        options: params.options,
        externalProfiles: getExternalProfiles,
      }),
    ),
  );
  const keptProfileIds = new Set(Object.keys(localStore.profiles));
  const keptOrderProfileIds = new Set(keptProfileIds);
  for (const profileId of params.options?.preserveStateProfileIds ?? []) {
    const normalizedProfileId = profileId.trim();
    if (normalizedProfileId) {
      keptProfileIds.add(normalizedProfileId);
      keptOrderProfileIds.add(normalizedProfileId);
    }
  }
  for (const profileIds of Object.values(
    loadPersistedAuthProfileState(params.agentDir).order ?? {},
  )) {
    for (const profileId of profileIds) {
      keptOrderProfileIds.add(profileId);
    }
  }
  for (const profileId of params.options?.preserveOrderProfileIds ?? []) {
    const normalizedProfileId = profileId.trim();
    if (normalizedProfileId) {
      keptOrderProfileIds.add(normalizedProfileId);
    }
  }
  const prunedOrderProfileIds = new Set<string>();
  for (const profileId of params.options?.pruneOrderProfileIds ?? []) {
    const normalizedProfileId = profileId.trim();
    if (normalizedProfileId) {
      prunedOrderProfileIds.add(normalizedProfileId);
    }
  }
  for (const profileId of prunedOrderProfileIds) {
    keptOrderProfileIds.delete(profileId);
  }
  pruneAuthProfileStoreReferences(localStore, keptProfileIds, keptOrderProfileIds);
  if (params.options?.filterExternalAuthProfiles !== false) {
    localStore.runtimeExternalProfileIds = undefined;
    localStore.runtimeExternalProfileIdsAuthoritative = undefined;
  }
  return localStore;
}

function buildAuthProfileStoreWithoutExternalProfiles(params: {
  store: AuthProfileStore;
  agentDir?: string;
  options?: Pick<LoadAuthProfileStoreOptions, "allowKeychainPrompt">;
}): AuthProfileStore {
  const runtimeExternalProfileIds = new Set(params.store.runtimeExternalProfileIds ?? []);
  const localStore = cloneAuthProfileStore(params.store);
  if (runtimeExternalProfileIds.size === 0) {
    return stripRuntimeExternalProfileMetadata(localStore);
  }
  for (const profileId of runtimeExternalProfileIds) {
    delete localStore.profiles[profileId];
  }
  const keptProfileIds = new Set(Object.keys(localStore.profiles));
  pruneAuthProfileStoreReferences(localStore, keptProfileIds);
  const persistedStore = loadAuthProfileStoreWithoutExternalProfiles(
    params.agentDir,
    params.options,
  );
  return stripRuntimeExternalProfileMetadata(mergeAuthProfileStores(persistedStore, localStore));
}

function stripRuntimeExternalProfileMetadata(store: AuthProfileStore): AuthProfileStore {
  const stripped = { ...store };
  delete stripped.runtimeExternalProfileIds;
  delete stripped.runtimeExternalProfileIdsAuthoritative;
  return stripped;
}

function markRuntimePersistedProfiles(
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

function buildRuntimeAuthProfileStoreForSave(params: {
  store: AuthProfileStore;
  agentDir?: string;
  options?: SaveAuthProfileStoreOptions;
}): AuthProfileStore {
  return buildLocalAuthProfileStoreForSave({
    ...params,
    options: {
      ...params.options,
      filterExternalAuthProfiles: false,
    },
  });
}

function setRuntimeLocalProfileMetadata(
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

function runtimeStoreInheritsMainState(
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

function listRuntimeLocalProfileIds(
  store: AuthProfileStore,
  mainStore?: AuthProfileStore,
): string[] {
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

function setRuntimeExternalProfileMetadata(params: {
  store: AuthProfileStore;
  profileIds: ReadonlySet<string>;
  authoritative: boolean;
}): void {
  const profileIds = [...params.profileIds].toSorted();
  params.store.runtimeExternalProfileIds =
    profileIds.length > 0 || params.authoritative ? profileIds : undefined;
  params.store.runtimeExternalProfileIdsAuthoritative = params.authoritative ? true : undefined;
}

function mergeRuntimeExternalProfileReferences(params: {
  next: AuthProfileStore;
  existing: AuthProfileStore;
}): AuthProfileStore {
  const runtimeExternalProfileIds = new Set(params.existing.runtimeExternalProfileIds ?? []);
  if (params.next.runtimeExternalProfileIdsAuthoritative === true) {
    return params.next;
  }
  if (runtimeExternalProfileIds.size === 0) {
    return params.next;
  }
  const merged = cloneAuthProfileStore(params.next);
  const mergedRuntimeExternalProfileIds = new Set(merged.runtimeExternalProfileIds ?? []);
  const backfilledRuntimeExternalProfileIds = new Set<string>();
  for (const profileId of runtimeExternalProfileIds) {
    const existingCredential = params.existing.profiles[profileId];
    const nextCredential = merged.profiles[profileId];
    if (nextCredential) {
      if (
        mergedRuntimeExternalProfileIds.has(profileId) ||
        (existingCredential && isDeepStrictEqual(nextCredential, existingCredential))
      ) {
        mergedRuntimeExternalProfileIds.add(profileId);
      }
      continue;
    }
    if (!existingCredential) {
      continue;
    }
    merged.profiles[profileId] = existingCredential;
    mergedRuntimeExternalProfileIds.add(profileId);
    backfilledRuntimeExternalProfileIds.add(profileId);
    if (params.existing.usageStats?.[profileId]) {
      merged.usageStats = {
        ...merged.usageStats,
        [profileId]: params.existing.usageStats[profileId],
      };
    }
  }
  for (const [provider, profileIds] of Object.entries(params.existing.order ?? {})) {
    const externalProfileIds = profileIds.filter((profileId) =>
      backfilledRuntimeExternalProfileIds.has(profileId),
    );
    if (externalProfileIds.length === 0) {
      continue;
    }
    if (merged.order?.[provider]) {
      continue;
    }
    const existingOrder = merged.order?.[provider] ?? [];
    merged.order = {
      ...merged.order,
      [provider]: [
        ...externalProfileIds,
        ...existingOrder.filter((profileId) => !externalProfileIds.includes(profileId)),
      ],
    };
  }
  for (const [provider, profileId] of Object.entries(params.existing.lastGood ?? {})) {
    if (!backfilledRuntimeExternalProfileIds.has(profileId) || merged.lastGood?.[provider]) {
      continue;
    }
    merged.lastGood = {
      ...merged.lastGood,
      [provider]: profileId,
    };
  }
  setRuntimeExternalProfileMetadata({
    store: merged,
    profileIds: mergedRuntimeExternalProfileIds,
    authoritative: params.existing.runtimeExternalProfileIdsAuthoritative === true,
  });
  return merged;
}

function preserveResolvedSecretBackedCredentials(params: {
  next: AuthProfileStore;
  existing: AuthProfileStore;
}): AuthProfileStore {
  const next = cloneAuthProfileStore(params.next);
  for (const [profileId, credential] of Object.entries(next.profiles)) {
    const existing = params.existing.profiles[profileId];
    if (
      credential.type === "api_key" &&
      existing?.type === "api_key" &&
      credential.key === undefined &&
      existing.key !== undefined &&
      isSecretRef(credential.keyRef) &&
      isDeepStrictEqual(credential.keyRef, existing.keyRef)
    ) {
      next.profiles[profileId] = { ...credential, key: existing.key };
    } else if (
      credential.type === "token" &&
      existing?.type === "token" &&
      credential.token === undefined &&
      existing.token !== undefined &&
      isSecretRef(credential.tokenRef) &&
      isDeepStrictEqual(credential.tokenRef, existing.tokenRef)
    ) {
      next.profiles[profileId] = { ...credential, token: existing.token };
    }
  }
  return next;
}

function mergeRuntimeExternalProfileState(params: {
  next: AuthProfileStore;
  existing: AuthProfileStore;
}): AuthProfileStore {
  const existingRuntimeProfileIds = new Set(params.existing.runtimeExternalProfileIds ?? []);
  if (existingRuntimeProfileIds.size === 0) {
    return params.next;
  }
  const merged = cloneAuthProfileStore(params.next);
  const mergedRuntimeProfileIds = new Set(merged.runtimeExternalProfileIds ?? []);
  const activeRuntimeProfileIds = new Set<string>();
  const nextRuntimeProfileIdsAuthoritative =
    params.next.runtimeExternalProfileIdsAuthoritative === true;
  for (const profileId of existingRuntimeProfileIds) {
    if (nextRuntimeProfileIdsAuthoritative && !mergedRuntimeProfileIds.has(profileId)) {
      continue;
    }
    const existingCredential = params.existing.profiles[profileId];
    if (!existingCredential) {
      continue;
    }
    const nextCredential = merged.profiles[profileId];
    if (nextCredential) {
      if (
        mergedRuntimeProfileIds.has(profileId) ||
        isDeepStrictEqual(nextCredential, existingCredential)
      ) {
        mergedRuntimeProfileIds.add(profileId);
        activeRuntimeProfileIds.add(profileId);
      }
      continue;
    }
    merged.profiles[profileId] = existingCredential;
    mergedRuntimeProfileIds.add(profileId);
    activeRuntimeProfileIds.add(profileId);
  }
  if (activeRuntimeProfileIds.size === 0) {
    return params.next;
  }
  for (const profileId of activeRuntimeProfileIds) {
    if (params.existing.usageStats?.[profileId]) {
      merged.usageStats = {
        ...merged.usageStats,
        [profileId]: params.existing.usageStats[profileId],
      };
    }
  }
  for (const [provider, profileIds] of Object.entries(params.existing.order ?? {})) {
    const externalProfileIds = profileIds.filter((profileId) =>
      activeRuntimeProfileIds.has(profileId),
    );
    if (externalProfileIds.length === 0 || merged.order?.[provider]) {
      continue;
    }
    merged.order = {
      ...merged.order,
      [provider]: externalProfileIds,
    };
  }
  for (const [provider, profileId] of Object.entries(params.existing.lastGood ?? {})) {
    if (!activeRuntimeProfileIds.has(profileId) || merged.lastGood?.[provider]) {
      continue;
    }
    merged.lastGood = {
      ...merged.lastGood,
      [provider]: profileId,
    };
  }
  setRuntimeExternalProfileMetadata({
    store: merged,
    profileIds: mergedRuntimeProfileIds,
    authoritative: params.existing.runtimeExternalProfileIdsAuthoritative === true,
  });
  return merged;
}

/** Apply an auth store update inside the SQLite write lock. */
export async function updateAuthProfileStoreWithLock(params: {
  agentDir?: string;
  saveOptions?: SaveAuthProfileStoreOptions;
  updater: (store: AuthProfileStore) => boolean;
}): Promise<AuthProfileStore | null> {
  let publishRuntimeSnapshots: (() => void) | undefined;
  let store: AuthProfileStore;
  try {
    store = runAuthProfileWriteTransaction(params.agentDir, (database) => {
      const loadedStore = loadAuthProfileStoreForAgent(params.agentDir, {
        database,
        readOnly: true,
        syncExternalCli: false,
      });
      const shouldSave = params.updater(loadedStore);
      if (shouldSave) {
        publishRuntimeSnapshots = saveAuthProfileStoreInTransaction(
          loadedStore,
          params.agentDir,
          params.saveOptions,
          database,
        );
      }
      return loadedStore;
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.warn(`auth profile store update failed: ${message}`, {
      agentDir: params.agentDir,
      error: message,
    });
    return null;
  }
  publishRuntimeSnapshotsAfterCommit(publishRuntimeSnapshots);
  return store;
}

/** Load the main auth profile store with runtime external profiles overlaid. */
export function loadAuthProfileStore(): AuthProfileStore {
  const asStore = loadPersistedAuthProfileStore();
  if (asStore) {
    return overlayExternalAuthProfiles(markRuntimePersistedProfiles(asStore));
  }

  const store: AuthProfileStore = { version: AUTH_STORE_VERSION, profiles: {} };
  return overlayExternalAuthProfiles(markRuntimePersistedProfiles(store));
}

function loadAuthProfileStoreForAgent(
  agentDir?: string,
  options?: LoadAuthProfileStoreOptions,
): AuthProfileStore {
  const readOnly = options?.readOnly === true;
  const asStore = loadPersistedAuthProfileStore(agentDir, resolvePersistedLoadOptions(options));
  if (asStore) {
    const synced = maybeSyncPersistedExternalCliAuthProfiles({
      store: asStore,
      agentDir,
      options,
    });
    return markRuntimePersistedProfiles(synced.store);
  }

  const store: AuthProfileStore = {
    version: AUTH_STORE_VERSION,
    profiles: {},
  };

  const mergedOAuth = mergeOAuthFileIntoStore(store);
  const forceReadOnly = process.env.OPENCLAW_AUTH_STORE_READONLY === "1";
  const shouldWrite = !readOnly && !forceReadOnly && mergedOAuth;
  if (shouldWrite) {
    saveAuthProfileStore(store, agentDir);
  }

  const synced = maybeSyncPersistedExternalCliAuthProfiles({
    store,
    agentDir,
    options,
  });
  return markRuntimePersistedProfiles(synced.store);
}

/** Loads the effective runtime store for an agent, including inherited main profiles. */
export function loadAuthProfileStoreForRuntime(
  agentDir?: string,
  options?: LoadAuthProfileStoreOptions,
): AuthProfileStore {
  const store = loadAuthProfileStoreForAgent(agentDir, options);
  const authPath = resolveAuthStorePath(agentDir);
  const mainAuthPath = resolveAuthStorePath();
  const externalCli = resolveExternalCliOverlayOptions(options);
  if (!agentDir || authPath === mainAuthPath) {
    return setRuntimeLocalProfileMetadata(
      overlayExternalAuthProfiles(store, {
        agentDir,
        ...externalCli,
      }),
      listRuntimeLocalProfileIds(store),
    );
  }

  const mainStore = loadAuthProfileStoreForAgent(undefined, options);
  const mergedStore = mergeAuthProfileStores(mainStore, store, {
    preserveBaseRuntimeExternalProfiles: true,
  });
  return setRuntimeLocalProfileMetadata(
    overlayExternalAuthProfiles(mergedStore, {
      agentDir,
      ...externalCli,
    }),
    listRuntimeLocalProfileIds(store, mainStore),
    runtimeStoreInheritsMainState(mergedStore, store),
  );
}

/** Load auth profiles for secret resolution without keychain prompts or writes. */
export function loadAuthProfileStoreForSecretsRuntime(
  agentDir?: string,
  options?: Pick<
    LoadAuthProfileStoreOptions,
    "config" | "externalCli" | "externalCliProviderIds" | "externalCliProfileIds"
  >,
): AuthProfileStore {
  return loadAuthProfileStoreForRuntime(agentDir, {
    ...options,
    readOnly: true,
    allowKeychainPrompt: false,
  });
}

/** Load auth profiles with runtime external profiles removed from the result. */
export function loadAuthProfileStoreWithoutExternalProfiles(
  agentDir?: string,
  loadOptions?: Pick<LoadAuthProfileStoreOptions, "allowKeychainPrompt">,
): AuthProfileStore {
  const options: LoadAuthProfileStoreOptions = {
    readOnly: true,
    allowKeychainPrompt: loadOptions?.allowKeychainPrompt ?? false,
  };
  const store = loadAuthProfileStoreForAgent(agentDir, options);
  const authPath = resolveAuthStorePath(agentDir);
  const mainAuthPath = resolveAuthStorePath();
  if (!agentDir || authPath === mainAuthPath) {
    return setRuntimeLocalProfileMetadata(
      stripRuntimeExternalProfileMetadata(store),
      listRuntimeLocalProfileIds(store),
    );
  }

  const mainStore = loadAuthProfileStoreForAgent(undefined, options);
  const mergedStore = mergeAuthProfileStores(mainStore, store, {
    preserveBaseRuntimeExternalProfiles: true,
  });
  return setRuntimeLocalProfileMetadata(
    stripRuntimeExternalProfileMetadata(mergedStore),
    listRuntimeLocalProfileIds(store, mainStore),
    runtimeStoreInheritsMainState(mergedStore, store),
  );
}

/** Ensure an auth store is available, including runtime/external profile overlays. */
export function ensureAuthProfileStore(
  agentDir?: string,
  options?: {
    allowKeychainPrompt?: boolean;
    config?: OpenClawConfig;
    externalCli?: ExternalCliAuthDiscovery;
    externalCliProviderIds?: Iterable<string>;
    externalCliProfileIds?: Iterable<string>;
    readOnly?: boolean;
    syncExternalCli?: boolean;
  },
): AuthProfileStore {
  const externalCli = resolveExternalCliOverlayOptions(options);
  const runtimeStore = resolveRuntimeAuthProfileStore(agentDir, options);
  const store = overlayExternalAuthProfiles(
    ensureAuthProfileStoreWithoutExternalProfiles(agentDir, options),
    {
      agentDir,
      ...externalCli,
    },
  );
  if (!runtimeStore || hasScopedExternalCliOverlay(externalCli)) {
    return store;
  }
  return mergeRuntimeExternalProfileState({
    next: store,
    existing: runtimeStore,
  });
}

/** Ensure an auth store is available without external profile overlays. */
export function ensureAuthProfileStoreWithoutExternalProfiles(
  agentDir?: string,
  options?: {
    allowKeychainPrompt?: boolean;
    readOnly?: boolean;
    syncExternalCli?: boolean;
  },
): AuthProfileStore {
  const effectiveOptions: LoadAuthProfileStoreOptions = {
    ...options,
  };
  const runtimeStore = resolveRuntimeAuthProfileStore(agentDir, effectiveOptions);
  if (runtimeStore) {
    return buildAuthProfileStoreWithoutExternalProfiles({
      store: runtimeStore,
      agentDir,
      options: effectiveOptions,
    });
  }
  const store = loadAuthProfileStoreForAgent(agentDir, effectiveOptions);
  const authPath = resolveAuthStorePath(agentDir);
  const mainAuthPath = resolveAuthStorePath();
  if (!agentDir || authPath === mainAuthPath) {
    return stripRuntimeExternalProfileMetadata(store);
  }

  const mainStore = loadAuthProfileStoreForAgent(undefined, effectiveOptions);
  return stripRuntimeExternalProfileMetadata(
    mergeAuthProfileStores(mainStore, store, {
      preserveBaseRuntimeExternalProfiles: true,
    }),
  );
}

/** Find a persisted credential in the scoped store, falling back to the main store. */
export function findPersistedAuthProfileCredential(params: {
  agentDir?: string;
  profileId: string;
}): AuthProfileStore["profiles"][string] | undefined {
  const requestedStore = loadPersistedAuthProfileStore(params.agentDir);
  const requestedProfile = requestedStore?.profiles[params.profileId];
  if (requestedProfile || !params.agentDir) {
    return requestedProfile;
  }

  const requestedPath = resolveAuthStorePath(params.agentDir);
  const mainPath = resolveAuthStorePath();
  if (requestedPath === mainPath) {
    return requestedProfile;
  }

  return loadPersistedAuthProfileStore()?.profiles[params.profileId];
}

/** Resolve which agent dir owns a persisted profile, accounting for inherited OAuth. */
export function resolvePersistedAuthProfileOwnerAgentDir(params: {
  agentDir?: string;
  profileId: string;
}): string | undefined {
  if (!params.agentDir) {
    return undefined;
  }
  const requestedStore = loadPersistedAuthProfileStore(params.agentDir);
  const requestedPath = resolveAuthStorePath(params.agentDir);
  const mainPath = resolveAuthStorePath();
  if (requestedPath === mainPath) {
    return undefined;
  }

  const mainStore = loadPersistedAuthProfileStore();
  const requestedProfile = requestedStore?.profiles[params.profileId];
  if (requestedProfile) {
    return shouldUseMainOwnerForLocalOAuthCredential({
      local: requestedProfile,
      main: mainStore?.profiles[params.profileId],
    })
      ? undefined
      : params.agentDir;
  }

  return mainStore?.profiles[params.profileId] ? undefined : params.agentDir;
}

/** Load the store shape used when applying local-only auth updates. */
export function ensureAuthProfileStoreForLocalUpdate(agentDir?: string): AuthProfileStore {
  const options: LoadAuthProfileStoreOptions = { syncExternalCli: false };
  const store = loadAuthProfileStoreForAgent(agentDir, options);
  const authPath = resolveAuthStorePath(agentDir);
  const mainAuthPath = resolveAuthStorePath();
  if (!agentDir || authPath === mainAuthPath) {
    return store;
  }

  const mainStore = loadAuthProfileStoreForAgent(undefined, {
    readOnly: true,
    syncExternalCli: false,
  });
  return mergeAuthProfileStores(mainStore, store, {
    preserveBaseRuntimeExternalProfiles: true,
  });
}

export {
  hasAnyAuthProfileStoreSource,
  hasAuthProfileStoreSourceForProvider,
  hasLocalAuthProfileStoreSource,
} from "./source-check.js";

/** Return the current runtime auth-profile snapshot for an agent dir. */
export function getRuntimeAuthProfileStoreSnapshot(
  agentDir?: string,
): AuthProfileStore | undefined {
  return getRuntimeAuthProfileStoreSnapshotImpl(agentDir);
}

/** Replace runtime auth-profile snapshots, used by tests and prepared runtimes. */
export function replaceRuntimeAuthProfileStoreSnapshots(
  entries: Array<{ agentDir?: string; store: AuthProfileStore }>,
): void {
  replaceRuntimeAuthProfileStoreSnapshotsImpl(entries);
}

/** Clear all runtime auth-profile snapshots. */
export function clearRuntimeAuthProfileStoreSnapshots(): void {
  clearRuntimeAuthProfileStoreSnapshotsImpl();
}

/** Clear one runtime auth-profile snapshot. */
export function clearRuntimeAuthProfileStoreSnapshot(agentDir?: string): boolean {
  return clearRuntimeAuthProfileStoreSnapshotImpl(agentDir);
}

function saveAuthProfileStoreInTransaction(
  store: AuthProfileStore,
  agentDir: string | undefined,
  options: SaveAuthProfileStoreOptions | undefined,
  database: OpenClawAgentDatabase,
  publishFromSuppliedStore = false,
): () => void {
  const savedAuthPath = resolveAuthStorePath(agentDir);
  const mainAuthPath = resolveAuthStorePath();
  const savesMainStore = savedAuthPath === mainAuthPath;
  const localStore = buildLocalAuthProfileStoreForSave({ store, agentDir, options });
  const existingRaw = readPersistedAuthProfileStoreRaw(agentDir, database);
  const payload = preserveLegacyOAuthRefsOnSave({
    payload: buildPersistedAuthProfileSecretsStore(localStore),
    existingRaw,
  });
  const existingProfiles =
    isRecord(existingRaw) && isRecord(existingRaw.profiles) ? existingRaw.profiles : {};
  const changedProfileIds = [
    ...new Set([...Object.keys(existingProfiles), ...Object.keys(payload.profiles)]),
  ].filter(
    (profileId) => !isDeepStrictEqual(existingProfiles[profileId], payload.profiles[profileId]),
  );
  const profileSetChanged = changedProfileIds.some(
    (profileId) =>
      Object.hasOwn(existingProfiles, profileId) !== Object.hasOwn(payload.profiles, profileId),
  );
  const credentialsChanged = !isDeepStrictEqual(existingRaw, payload);
  const statePayload = buildPersistedAuthProfileState(localStore);
  const stateChanged = !isDeepStrictEqual(
    readPersistedAuthProfileStateRaw(agentDir, database),
    statePayload,
  );
  const suppliedRuntimeStore = publishFromSuppliedStore
    ? markRuntimePersistedProfiles(
        buildRuntimeAuthProfileStoreForSave({ store, agentDir, options }),
        localStore,
      )
    : undefined;
  if (credentialsChanged) {
    writePersistedAuthProfileStoreRaw(payload, agentDir, database);
  }
  if (stateChanged) {
    writePersistedAuthProfileStateRaw(statePayload, agentDir, database);
  }
  const publishRuntimeSnapshots = () => {
    // Main-store publication invalidates derived stores. Capture the latest
    // overlays at the publication edge so post-commit refreshes are retained.
    const derivedSnapshots = savesMainStore
      ? listRuntimeAuthProfileStoreSnapshots().filter(
          (entry) => resolveAuthStorePath(entry.agentDir) !== mainAuthPath,
        )
      : [];
    if (credentialsChanged || stateChanged) {
      noteRuntimeAuthProfileStorePersistedMutation(agentDir, {
        credentialsChanged,
        profileSetChanged,
        stateChanged,
        profileIds: changedProfileIds,
      });
    }
    if (suppliedRuntimeStore) {
      const existing = getRuntimeAuthProfileStoreSnapshot(agentDir);
      if (existing) {
        setRuntimeAuthProfileStoreSnapshot(
          mergeRuntimeExternalProfileReferences({ next: suppliedRuntimeStore, existing }),
          agentDir,
        );
      }
      if (savesMainStore && (credentialsChanged || stateChanged)) {
        for (const derived of derivedSnapshots) {
          const refreshed = loadAuthProfileStoreWithoutExternalProfiles(derived.agentDir);
          const materialized = preserveResolvedSecretBackedCredentials({
            next: refreshed,
            existing: derived.store,
          });
          setRuntimeAuthProfileStoreSnapshot(
            mergeRuntimeExternalProfileReferences({ next: materialized, existing: derived.store }),
            derived.agentDir,
          );
        }
      }
      return;
    }
    refreshRuntimeAuthProfileStoreSnapshot(agentDir);
    for (const derived of derivedSnapshots) {
      const refreshed = loadAuthProfileStoreWithoutExternalProfiles(derived.agentDir);
      const materialized = preserveResolvedSecretBackedCredentials({
        next: refreshed,
        existing: derived.store,
      });
      setRuntimeAuthProfileStoreSnapshot(
        mergeRuntimeExternalProfileReferences({ next: materialized, existing: derived.store }),
        derived.agentDir,
      );
    }
  };
  return publishRuntimeSnapshots;
}

/** Save the auth profile store plus sidecar state, preserving runtime overlay metadata. */
export function saveAuthProfileStore(
  store: AuthProfileStore,
  agentDir?: string,
  options?: SaveAuthProfileStoreOptions,
  database?: OpenClawAgentDatabase,
): void {
  if (database) {
    const publishRuntimeSnapshots = saveAuthProfileStoreInTransaction(
      store,
      agentDir,
      options,
      database,
      true,
    );
    const publishAfterCommit = () => {
      publishRuntimeSnapshotsAfterCommit(publishRuntimeSnapshots);
    };
    if (!deferOpenClawAgentPostCommitPublication(database, publishAfterCommit)) {
      // A supplied connection outside the transaction wrapper autocommits each write.
      publishAfterCommit();
    }
    return;
  }
  let publishRuntimeSnapshots: (() => void) | undefined;
  runAuthProfileWriteTransaction(agentDir, (transactionDatabase) => {
    publishRuntimeSnapshots = saveAuthProfileStoreInTransaction(
      store,
      agentDir,
      options,
      transactionDatabase,
    );
  });
  publishRuntimeSnapshotsAfterCommit(publishRuntimeSnapshots);
}

type AuthProfileStorePersistenceSnapshot = {
  credentialsRaw: unknown;
  stateRaw: unknown;
  runtimeCaptured: boolean;
  runtimeRevision?: number;
  runtimeRevisionAtSaveEdge?: number;
  runtimeRevisionBeforePublication?: number;
  runtimeStore?: AuthProfileStore;
  derivedRuntimeStores?: Array<{
    agentDir: string;
    store: AuthProfileStore;
    runtimeRevision?: number;
  }>;
  derivedRuntimeRevisionsAtSaveEdge?: Array<{ agentDir: string; runtimeRevision: number }>;
  derivedRuntimeRevisionsBeforePublication?: Array<{
    agentDir: string;
    runtimeRevision: number;
  }>;
};

type CommittedAuthProfileStoreSave = {
  owned: AuthProfileStorePersistenceSnapshot;
  publishRuntimeSnapshots: () => boolean;
};

function captureRuntimeAuthProfileStorePersistenceSnapshot(
  agentDir?: string,
): Pick<
  AuthProfileStorePersistenceSnapshot,
  "runtimeCaptured" | "runtimeRevision" | "runtimeStore" | "derivedRuntimeStores"
> {
  const capturedAuthPath = resolveAuthStorePath(agentDir);
  const mainAuthPath = resolveAuthStorePath(undefined);
  return {
    runtimeCaptured: true,
    runtimeRevision: getRuntimeAuthProfileStoreSnapshotRevision(agentDir),
    runtimeStore: getRuntimeAuthProfileStoreSnapshot(agentDir),
    derivedRuntimeStores:
      capturedAuthPath === mainAuthPath
        ? listRuntimeAuthProfileStoreSnapshots()
            .filter((entry) => resolveAuthStorePath(entry.agentDir) !== mainAuthPath)
            .map(({ agentDir: derivedAgentDir, store }) => ({
              agentDir: derivedAgentDir,
              store,
              runtimeRevision: getRuntimeAuthProfileStoreSnapshotRevision(derivedAgentDir),
            }))
        : [],
  };
}

function recordRuntimeAuthProfileStoreOwnership(
  owned: AuthProfileStorePersistenceSnapshot,
  runtime: ReturnType<typeof captureRuntimeAuthProfileStorePersistenceSnapshot>,
): void {
  // The raw rows are the compare-and-swap token captured under the SQLite
  // transaction. Never replace them with a later persistence read.
  owned.runtimeCaptured = runtime.runtimeCaptured;
  if (runtime.runtimeRevision !== undefined) {
    owned.runtimeRevision = runtime.runtimeRevision;
  }
  if (runtime.runtimeStore !== undefined) {
    owned.runtimeStore = runtime.runtimeStore;
  }
  if (runtime.derivedRuntimeStores !== undefined) {
    owned.derivedRuntimeStores = runtime.derivedRuntimeStores;
  }
}

function recordRuntimeAuthProfileStorePublicationEdge(
  owned: AuthProfileStorePersistenceSnapshot,
  runtime: ReturnType<typeof captureRuntimeAuthProfileStorePersistenceSnapshot>,
): void {
  if (runtime.runtimeRevision !== undefined) {
    owned.runtimeRevisionBeforePublication = runtime.runtimeRevision;
  }
  if (runtime.derivedRuntimeStores !== undefined) {
    owned.derivedRuntimeRevisionsBeforePublication = runtime.derivedRuntimeStores.flatMap((entry) =>
      typeof entry.runtimeRevision === "number"
        ? [{ agentDir: entry.agentDir, runtimeRevision: entry.runtimeRevision }]
        : [],
    );
  }
}

function replaceRuntimeAuthProfileStoreSnapshot(
  store: AuthProfileStore | undefined,
  agentDir?: string,
): void {
  if (store) {
    setRuntimeAuthProfileStoreSnapshot(store, agentDir);
    return;
  }
  const replacedAuthPath = resolveAuthStorePath(agentDir);
  replaceRuntimeAuthProfileStoreSnapshotsImpl(
    listRuntimeAuthProfileStoreSnapshots().filter(
      (entry) => resolveAuthStorePath(entry.agentDir) !== replacedAuthPath,
    ),
  );
}

function refreshRuntimeAuthProfileStoreSnapshot(agentDir?: string): void {
  const existing = getRuntimeAuthProfileStoreSnapshot(agentDir);
  if (!existing) {
    return;
  }
  rebuildRuntimeAuthProfileStoreSnapshot(agentDir, existing);
}

function rebuildRuntimeAuthProfileStoreSnapshot(
  agentDir: string | undefined,
  existing: AuthProfileStore,
  predecessor?: AuthProfileStore,
): void {
  const refreshed = loadAuthProfileStoreWithoutExternalProfiles(agentDir);
  const currentMaterialized = preserveResolvedSecretBackedCredentials({
    next: refreshed,
    existing,
  });
  const materialized = predecessor
    ? preserveResolvedSecretBackedCredentials({
        next: currentMaterialized,
        existing: predecessor,
      })
    : currentMaterialized;
  const rebuilt = mergeRuntimeExternalProfileReferences({ next: materialized, existing });
  setRuntimeAuthProfileStoreSnapshot(rebuilt, agentDir);
}

/** Capture both persisted auth rows under one database lock. */
export function captureAuthProfileStorePersistenceSnapshot(
  agentDir?: string,
): AuthProfileStorePersistenceSnapshot {
  return runAuthProfileWriteTransaction(agentDir, (database) => {
    return {
      credentialsRaw: readPersistedAuthProfileStoreRaw(agentDir, database),
      stateRaw: readPersistedAuthProfileStateRaw(agentDir, database),
      ...captureRuntimeAuthProfileStorePersistenceSnapshot(agentDir),
    };
  });
}

/**
 * Commit only while both persisted auth rows still match the captured baseline.
 * The caller claims `owned` before publishing because publication is fallible.
 */
export function saveAuthProfileStoreIfPersistenceSnapshotMatches(params: {
  store: AuthProfileStore;
  snapshot: AuthProfileStorePersistenceSnapshot;
  agentDir?: string;
  options?: SaveAuthProfileStoreOptions;
}): CommittedAuthProfileStoreSave {
  let publishRuntimeSnapshots: (() => void) | undefined;
  const owned: AuthProfileStorePersistenceSnapshot = {
    credentialsRaw: null,
    stateRaw: null,
    runtimeCaptured: false,
  };
  runAuthProfileWriteTransaction(params.agentDir, (database) => {
    const currentCredentials = readPersistedAuthProfileStoreRaw(params.agentDir, database);
    const currentState = readPersistedAuthProfileStateRaw(params.agentDir, database);
    if (
      !isDeepStrictEqual(currentCredentials, params.snapshot.credentialsRaw) ||
      !isDeepStrictEqual(currentState, params.snapshot.stateRaw)
    ) {
      throw new Error("auth profile store changed after secrets apply captured it");
    }
    const runtimeAtSaveEdge = captureRuntimeAuthProfileStorePersistenceSnapshot(params.agentDir);
    owned.runtimeRevisionAtSaveEdge = runtimeAtSaveEdge.runtimeRevision;
    owned.derivedRuntimeRevisionsAtSaveEdge = runtimeAtSaveEdge.derivedRuntimeStores?.flatMap(
      (entry) =>
        typeof entry.runtimeRevision === "number"
          ? [{ agentDir: entry.agentDir, runtimeRevision: entry.runtimeRevision }]
          : [],
    );
    publishRuntimeSnapshots = saveAuthProfileStoreInTransaction(
      params.store,
      params.agentDir,
      params.options,
      database,
    );
    owned.credentialsRaw = readPersistedAuthProfileStoreRaw(params.agentDir, database);
    owned.stateRaw = readPersistedAuthProfileStateRaw(params.agentDir, database);
  });
  return {
    owned,
    publishRuntimeSnapshots: () =>
      publishRuntimeSnapshotsAfterCommit(() => {
        recordRuntimeAuthProfileStorePublicationEdge(
          owned,
          captureRuntimeAuthProfileStorePersistenceSnapshot(params.agentDir),
        );
        publishRuntimeSnapshots?.();
        recordRuntimeAuthProfileStoreOwnership(
          owned,
          captureRuntimeAuthProfileStorePersistenceSnapshot(params.agentDir),
        );
      }),
  };
}

function reconcileRuntimeAuthProfileStorePersistenceSnapshot(params: {
  snapshot: AuthProfileStorePersistenceSnapshot;
  owned: AuthProfileStorePersistenceSnapshot;
  agentDir?: string;
  credentialsOwned: boolean;
  stateOwned: boolean;
  credentialsRestored: boolean;
  stateRestored: boolean;
  currentRuntimeStores: Array<{
    agentDir: string;
    store: AuthProfileStore;
    runtimeRevision: number;
  }>;
  currentRuntimeRevision: number;
}): void {
  if (!params.snapshot.runtimeCaptured || !params.owned.runtimeCaptured) {
    return;
  }
  const rowsFullyOwned = params.credentialsOwned && params.stateOwned;
  const rowsRestored = params.credentialsRestored || params.stateRestored;
  const reconcileOne = (
    agentDir: string | undefined,
    snapshotStore: AuthProfileStore | undefined,
    snapshotRuntimeRevision: number | undefined,
    runtimeRevisionAtSaveEdge: number | undefined,
    runtimeRevisionBeforePublication: number | undefined,
    ownedStore: AuthProfileStore | undefined,
    ownedRuntimeRevision: number | undefined,
    currentStore: AuthProfileStore | undefined,
    currentRuntimeRevision: number,
  ) => {
    const runtimeGenerationOwned =
      typeof snapshotRuntimeRevision === "number" &&
      typeof runtimeRevisionAtSaveEdge === "number" &&
      typeof runtimeRevisionBeforePublication === "number" &&
      typeof ownedRuntimeRevision === "number" &&
      snapshotRuntimeRevision === runtimeRevisionAtSaveEdge &&
      runtimeRevisionAtSaveEdge === runtimeRevisionBeforePublication &&
      currentRuntimeRevision === ownedRuntimeRevision;
    if (rowsFullyOwned && runtimeGenerationOwned && isDeepStrictEqual(currentStore, ownedStore)) {
      replaceRuntimeAuthProfileStoreSnapshot(snapshotStore, agentDir);
    } else if (rowsRestored && currentStore) {
      // Current overlays win, while the predecessor can still supply materialized
      // values for final keyRefs that the candidate temporarily removed.
      rebuildRuntimeAuthProfileStoreSnapshot(agentDir, currentStore, snapshotStore);
    }
  };

  const restoredAuthPath = resolveAuthStorePath(params.agentDir);
  const mainAuthPath = resolveAuthStorePath(undefined);
  const currentRuntimeStores = new Map(
    params.currentRuntimeStores.map((entry) => [resolveAuthStorePath(entry.agentDir), entry]),
  );
  reconcileOne(
    params.agentDir,
    params.snapshot.runtimeStore,
    params.snapshot.runtimeRevision,
    params.owned.runtimeRevisionAtSaveEdge,
    params.owned.runtimeRevisionBeforePublication,
    params.owned.runtimeStore,
    params.owned.runtimeRevision,
    currentRuntimeStores.get(restoredAuthPath)?.store,
    params.currentRuntimeRevision,
  );
  if (restoredAuthPath !== mainAuthPath) {
    return;
  }
  const snapshotDerived = new Map(
    (params.snapshot.derivedRuntimeStores ?? []).map((entry) => [
      resolveAuthStorePath(entry.agentDir),
      entry,
    ]),
  );
  const ownedDerived = new Map(
    (params.owned.derivedRuntimeStores ?? []).map((entry) => [
      resolveAuthStorePath(entry.agentDir),
      entry,
    ]),
  );
  const saveEdgeDerivedRevisions = new Map(
    (params.owned.derivedRuntimeRevisionsAtSaveEdge ?? []).map((entry) => [
      resolveAuthStorePath(entry.agentDir),
      entry.runtimeRevision,
    ]),
  );
  const publicationEdgeDerivedRevisions = new Map(
    (params.owned.derivedRuntimeRevisionsBeforePublication ?? []).map((entry) => [
      resolveAuthStorePath(entry.agentDir),
      entry.runtimeRevision,
    ]),
  );
  for (const [pathname, currentEntry] of currentRuntimeStores) {
    if (pathname === mainAuthPath) {
      continue;
    }
    const snapshotEntry = snapshotDerived.get(pathname);
    const ownedEntry = ownedDerived.get(pathname);
    reconcileOne(
      currentEntry.agentDir,
      snapshotEntry?.store,
      snapshotEntry?.runtimeRevision,
      saveEdgeDerivedRevisions.get(pathname),
      publicationEdgeDerivedRevisions.get(pathname),
      ownedEntry?.store,
      ownedEntry?.runtimeRevision,
      currentEntry.store,
      currentEntry.runtimeRevision,
    );
  }
}

/** Restore each persisted row and runtime snapshot only while apply still owns it. */
export function restoreAuthProfileStorePersistenceSnapshot(
  snapshot: AuthProfileStorePersistenceSnapshot,
  owned: AuthProfileStorePersistenceSnapshot,
  agentDir?: string,
): void {
  let credentialsOwned = false;
  let stateOwned = false;
  let credentialsRestored = false;
  let stateRestored = false;
  let publishRuntimeSnapshots: (() => void) | undefined;
  runAuthProfileWriteTransaction(agentDir, (database) => {
    const existingRaw = readPersistedAuthProfileStoreRaw(agentDir, database);
    const existingState = readPersistedAuthProfileStateRaw(agentDir, database);
    credentialsOwned = isDeepStrictEqual(existingRaw, owned.credentialsRaw);
    stateOwned = isDeepStrictEqual(existingState, owned.stateRaw);
    const beforeProfiles =
      isRecord(existingRaw) && isRecord(existingRaw.profiles) ? existingRaw.profiles : {};
    const restoredProfiles =
      isRecord(snapshot.credentialsRaw) && isRecord(snapshot.credentialsRaw.profiles)
        ? snapshot.credentialsRaw.profiles
        : {};
    const changedProfileIds = [
      ...new Set([...Object.keys(beforeProfiles), ...Object.keys(restoredProfiles)]),
    ].filter(
      (profileId) => !isDeepStrictEqual(beforeProfiles[profileId], restoredProfiles[profileId]),
    );
    const profileSetChanged = changedProfileIds.some(
      (profileId) =>
        Object.hasOwn(beforeProfiles, profileId) !== Object.hasOwn(restoredProfiles, profileId),
    );
    credentialsRestored =
      credentialsOwned && !isDeepStrictEqual(existingRaw, snapshot.credentialsRaw);
    stateRestored = stateOwned && !isDeepStrictEqual(existingState, snapshot.stateRaw);

    if (credentialsRestored) {
      if (snapshot.credentialsRaw === null) {
        deletePersistedAuthProfileStoreRaw(agentDir, database);
      } else {
        writePersistedAuthProfileStoreRaw(snapshot.credentialsRaw, agentDir, database);
      }
    }
    if (stateRestored) {
      writePersistedAuthProfileStateRaw(snapshot.stateRaw, agentDir, database);
    }
    publishRuntimeSnapshots = () => {
      // Main credential mutation lineage invalidates derived snapshots. Capture
      // them first so exact-owned entries can restore and newer entries rebuild.
      const currentRuntimeStores = listRuntimeAuthProfileStoreSnapshots().map(
        ({ agentDir: runtimeAgentDir, store }) => ({
          agentDir: runtimeAgentDir,
          store,
          runtimeRevision: getRuntimeAuthProfileStoreSnapshotRevision(runtimeAgentDir),
        }),
      );
      const currentRuntimeRevision = getRuntimeAuthProfileStoreSnapshotRevision(agentDir);
      if (credentialsRestored || stateRestored) {
        noteRuntimeAuthProfileStorePersistedMutation(agentDir, {
          credentialsChanged: credentialsRestored,
          profileSetChanged: credentialsRestored && profileSetChanged,
          stateChanged: stateRestored,
          profileIds: credentialsRestored ? changedProfileIds : [],
        });
      }
      reconcileRuntimeAuthProfileStorePersistenceSnapshot({
        snapshot,
        owned,
        agentDir,
        credentialsOwned,
        stateOwned,
        credentialsRestored,
        stateRestored,
        currentRuntimeStores,
        currentRuntimeRevision,
      });
    };
  });
  publishRuntimeSnapshotsAfterCommit(publishRuntimeSnapshots);
}
