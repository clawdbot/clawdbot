import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withFileLock } from "../../infra/file-lock.js";
import { loadJsonFile, repairJsonFilePermissions, saveJsonFile } from "../../infra/json-file.js";
import { asDateTimestampMs } from "../../shared/number-coercion.js";
import { isRecord } from "../../utils.js";
import { cloneAuthProfileStore } from "./clone.js";
import { AUTH_STORE_LOCK_OPTIONS, AUTH_STORE_VERSION, log } from "./constants.js";
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
import {
  ensureAuthStoreFile,
  resolveAuthStatePath,
  resolveAuthStorePath,
  resolveLegacyAuthStorePath,
} from "./paths.js";
import {
  applyLegacyAuthStore,
  buildPersistedAuthProfileSecretsStore,
  loadLegacyAuthProfileStore,
  loadPersistedAuthProfileStore,
  mergeAuthProfileStores,
  mergeOAuthFileIntoStore,
} from "./persisted.js";
import {
  clearRuntimeAuthProfileStoreSnapshots as clearRuntimeAuthProfileStoreSnapshotsImpl,
  getRuntimeAuthProfileStoreSnapshot as getRuntimeAuthProfileStoreSnapshotImpl,
  hasRuntimeAuthProfileStoreSnapshot,
  replaceRuntimeAuthProfileStoreSnapshots as replaceRuntimeAuthProfileStoreSnapshotsImpl,
  setRuntimeAuthProfileStoreSnapshot,
} from "./runtime-snapshots.js";
import { savePersistedAuthProfileState } from "./state.js";
import {
  clearLoadedAuthStoreCache,
  readCachedAuthProfileStore,
  writeCachedAuthProfileStore,
} from "./store-cache.js";
import type { AuthProfileStore } from "./types.js";

type LoadAuthProfileStoreOptions = {
  allowKeychainPrompt?: boolean;
  config?: OpenClawConfig;
  externalCli?: ExternalCliAuthDiscovery;
  readOnly?: boolean;
  syncExternalCli?: boolean;
  externalCliProviderIds?: Iterable<string>;
  externalCliProfileIds?: Iterable<string>;
};

type SaveAuthProfileStoreOptions = {
  filterExternalAuthProfiles?: boolean;
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

type SyncLockSnapshot = {
  raw: string;
  stat: fs.Stats;
  payload: Record<string, unknown> | null;
};

type ExternalCliSyncResult = {
  store: AuthProfileStore;
  cacheable: boolean;
};

function resolvePersistedLoadOptions(
  options: Pick<LoadAuthProfileStoreOptions, "allowKeychainPrompt"> | undefined,
): { allowKeychainPrompt?: boolean } {
  return options?.allowKeychainPrompt !== undefined
    ? { allowKeychainPrompt: options.allowKeychainPrompt }
    : {};
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
    return mainStore;
  }

  return null;
}

function readAuthStoreMtimeMs(authPath: string): number | null {
  try {
    return fs.statSync(authPath).mtimeMs;
  } catch {
    return null;
  }
}

function readSyncLockSnapshot(lockPath: string): SyncLockSnapshot | null {
  try {
    const stat = fs.lstatSync(lockPath);
    const raw = fs.readFileSync(lockPath, "utf8");
    let payload: Record<string, unknown> | null = null;
    try {
      const parsed = JSON.parse(raw) as unknown;
      payload =
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : null;
    } catch {
      payload = null;
    }
    return { raw, stat, payload };
  } catch {
    return null;
  }
}

function syncLockSnapshotMatches(lockPath: string, snapshot: SyncLockSnapshot): boolean {
  try {
    const stat = fs.lstatSync(lockPath);
    return (
      stat.dev === snapshot.stat.dev &&
      stat.ino === snapshot.stat.ino &&
      fs.readFileSync(lockPath, "utf8") === snapshot.raw
    );
  } catch {
    return false;
  }
}

function acquireAuthStoreLockSync(authPath: string): (() => void) | null {
  const lockPath = `${authPath}.lock`;
  fs.mkdirSync(path.dirname(authPath), { recursive: true });

  try {
    const fd = fs.openSync(lockPath, "wx");
    const raw = `${JSON.stringify(
      { pid: process.pid, createdAt: new Date().toISOString() },
      null,
      2,
    )}\n`;
    try {
      fs.writeFileSync(fd, raw, "utf8");
    } finally {
      fs.closeSync(fd);
    }
    const snapshot = readSyncLockSnapshot(lockPath);
    return () => {
      if (snapshot && syncLockSnapshotMatches(lockPath, snapshot)) {
        fs.rmSync(lockPath, { force: true });
      }
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "EEXIST") {
      return null;
    }
    throw err;
  }
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

  const authPath = resolveAuthStorePath(params.agentDir);
  const release = acquireAuthStoreLockSync(authPath);
  if (!release) {
    log.warn("skipped persisted external cli auth sync because auth store is locked", {
      authPath,
    });
    return { store: params.store, cacheable: false };
  }
  try {
    const latestStore = loadPersistedAuthProfileStore(
      params.agentDir,
      resolvePersistedLoadOptions(params.options),
    ) ?? {
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
      saveAuthProfileStore(latestStore, params.agentDir, {
        filterExternalAuthProfiles: false,
      });
      return { store: latestStore, cacheable: true };
    }
    return { store: latestStore, cacheable: true };
  } finally {
    release();
  }
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
  store: AuthProfileStore,
  keptProfileIds: Set<string>,
): void {
  store.order = store.order
    ? Object.fromEntries(
        Object.entries(store.order)
          .map(([provider, profileIds]) => [
            provider,
            profileIds.filter((profileId) => keptProfileIds.has(profileId)),
          ])
          .filter(([, profileIds]) => profileIds.length > 0),
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
  pruneAuthProfileStoreReferences(localStore, keptProfileIds);
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
    localStore.runtimeExternalProfileIds = undefined;
    localStore.runtimeExternalProfileIdsAuthoritative = undefined;
    return localStore;
  }
  for (const profileId of runtimeExternalProfileIds) {
    delete localStore.profiles[profileId];
  }
  const keptProfileIds = new Set(Object.keys(localStore.profiles));
  pruneAuthProfileStoreReferences(localStore, keptProfileIds);
  localStore.runtimeExternalProfileIds = undefined;
  localStore.runtimeExternalProfileIdsAuthoritative = undefined;
  const persistedStore = loadAuthProfileStoreWithoutExternalProfiles(
    params.agentDir,
    params.options,
  );
  return mergeAuthProfileStores(persistedStore, localStore);
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

export async function updateAuthProfileStoreWithLock(params: {
  agentDir?: string;
  saveOptions?: SaveAuthProfileStoreOptions;
  updater: (store: AuthProfileStore) => boolean;
}): Promise<AuthProfileStore | null> {
  const authPath = resolveAuthStorePath(params.agentDir);
  ensureAuthStoreFile(authPath);

  try {
    return await withFileLock(authPath, AUTH_STORE_LOCK_OPTIONS, async () => {
      // Locked writers must reload from disk, not from any runtime snapshot.
      // Otherwise a live gateway can overwrite fresher CLI/config-auth writes
      // with stale in-memory auth state during usage/cooldown updates.
      const store = loadAuthProfileStoreForAgent(params.agentDir, { syncExternalCli: false });
      const shouldSave = params.updater(store);
      if (shouldSave) {
        saveAuthProfileStore(store, params.agentDir, params.saveOptions);
      }
      return store;
    });
  } catch {
    return null;
  }
}

export function loadAuthProfileStore(): AuthProfileStore {
  const asStore = loadPersistedAuthProfileStore();
  if (asStore) {
    return overlayExternalAuthProfiles(asStore);
  }
  const legacy = loadLegacyAuthProfileStore();
  if (legacy) {
    const store: AuthProfileStore = {
      version: AUTH_STORE_VERSION,
      profiles: {},
    };
    applyLegacyAuthStore(store, legacy);
    return overlayExternalAuthProfiles(store);
  }

  const store: AuthProfileStore = { version: AUTH_STORE_VERSION, profiles: {} };
  return overlayExternalAuthProfiles(store);
}

function loadAuthProfileStoreForAgent(
  agentDir?: string,
  options?: LoadAuthProfileStoreOptions,
): AuthProfileStore {
  const readOnly = options?.readOnly === true;
  const authPath = resolveAuthStorePath(agentDir);
  const statePath = resolveAuthStatePath(agentDir);
  const authMtimeMs = readAuthStoreMtimeMs(authPath);
  const stateMtimeMs = readAuthStoreMtimeMs(statePath);
  if (!readOnly) {
    const cached = readCachedAuthProfileStore({
      authPath,
      authMtimeMs,
      stateMtimeMs,
    });
    if (cached) {
      return cached;
    }
  }
  const asStore = loadPersistedAuthProfileStore(agentDir, resolvePersistedLoadOptions(options));
  if (asStore) {
    const synced = maybeSyncPersistedExternalCliAuthProfiles({
      store: asStore,
      agentDir,
      options,
    });
    if (!readOnly && synced.cacheable) {
      writeCachedAuthProfileStore({
        authPath,
        authMtimeMs: readAuthStoreMtimeMs(authPath),
        stateMtimeMs: readAuthStoreMtimeMs(statePath),
        store: synced.store,
      });
    }
    return synced.store;
  }

  const legacy = loadLegacyAuthProfileStore(agentDir);
  const store: AuthProfileStore = {
    version: AUTH_STORE_VERSION,
    profiles: {},
  };
  if (legacy) {
    applyLegacyAuthStore(store, legacy);
  }

  const mergedOAuth = mergeOAuthFileIntoStore(store);
  const forceReadOnly = process.env.OPENCLAW_AUTH_STORE_READONLY === "1";
  const shouldWrite = !readOnly && !forceReadOnly && (legacy !== null || mergedOAuth);
  if (shouldWrite) {
    saveAuthProfileStore(store, agentDir);
  }

  // PR #368: legacy auth.json could get re-migrated from other agent dirs,
  // overwriting fresh OAuth creds with stale tokens (fixes #363). Delete only
  // after we've successfully written auth-profiles.json.
  if (shouldWrite && legacy !== null) {
    const legacyPath = resolveLegacyAuthStorePath(agentDir);
    try {
      fs.unlinkSync(legacyPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
        log.warn("failed to delete legacy auth.json after migration", {
          err,
          legacyPath,
        });
      }
    }
  }

  const synced = maybeSyncPersistedExternalCliAuthProfiles({
    store,
    agentDir,
    options,
  });

  if (!readOnly && synced.cacheable) {
    writeCachedAuthProfileStore({
      authPath,
      authMtimeMs: readAuthStoreMtimeMs(authPath),
      stateMtimeMs: readAuthStoreMtimeMs(statePath),
      store: synced.store,
    });
  }
  return synced.store;
}

export function loadAuthProfileStoreForRuntime(
  agentDir?: string,
  options?: LoadAuthProfileStoreOptions,
): AuthProfileStore {
  const store = loadAuthProfileStoreForAgent(agentDir, options);
  const authPath = resolveAuthStorePath(agentDir);
  const mainAuthPath = resolveAuthStorePath();
  const externalCli = resolveExternalCliOverlayOptions(options);
  if (!agentDir || authPath === mainAuthPath) {
    return overlayExternalAuthProfiles(store, {
      agentDir,
      ...externalCli,
    });
  }

  const mainStore = loadAuthProfileStoreForAgent(undefined, options);
  return overlayExternalAuthProfiles(
    mergeAuthProfileStores(mainStore, store, {
      preserveBaseRuntimeExternalProfiles: true,
    }),
    {
      agentDir,
      ...externalCli,
    },
  );
}

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
    return store;
  }

  const mainStore = loadAuthProfileStoreForAgent(undefined, options);
  return mergeAuthProfileStores(mainStore, store, {
    preserveBaseRuntimeExternalProfiles: true,
  });
}

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
    return store;
  }

  const mainStore = loadAuthProfileStoreForAgent(undefined, effectiveOptions);
  return mergeAuthProfileStores(mainStore, store, {
    preserveBaseRuntimeExternalProfiles: true,
  });
}

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

export { hasAnyAuthProfileStoreSource } from "./source-check.js";

export function getRuntimeAuthProfileStoreSnapshot(
  agentDir?: string,
): AuthProfileStore | undefined {
  return getRuntimeAuthProfileStoreSnapshotImpl(agentDir);
}

export function replaceRuntimeAuthProfileStoreSnapshots(
  entries: Array<{ agentDir?: string; store: AuthProfileStore }>,
): void {
  replaceRuntimeAuthProfileStoreSnapshotsImpl(entries);
}

export function clearRuntimeAuthProfileStoreSnapshots(): void {
  clearRuntimeAuthProfileStoreSnapshotsImpl();
  clearLoadedAuthStoreCache();
}

export function saveAuthProfileStore(
  store: AuthProfileStore,
  agentDir?: string,
  options?: SaveAuthProfileStoreOptions,
): void {
  const authPath = resolveAuthStorePath(agentDir);
  const statePath = resolveAuthStatePath(agentDir);
  const localStore = buildLocalAuthProfileStoreForSave({ store, agentDir, options });
  const existingRaw = loadJsonFile(authPath);
  const payload = preserveLegacyOAuthRefsOnSave({
    payload: buildPersistedAuthProfileSecretsStore(localStore),
    existingRaw,
  });
  if (isDeepStrictEqual(existingRaw, payload)) {
    repairJsonFilePermissions(authPath);
  } else {
    saveJsonFile(authPath, payload);
  }
  savePersistedAuthProfileState(localStore, agentDir);
  writeCachedAuthProfileStore({
    authPath,
    authMtimeMs: readAuthStoreMtimeMs(authPath),
    stateMtimeMs: readAuthStoreMtimeMs(statePath),
    store: localStore,
  });
  if (hasRuntimeAuthProfileStoreSnapshot(agentDir)) {
    const existingRuntimeStore = getRuntimeAuthProfileStoreSnapshot(agentDir);
    const nextRuntimeStore = buildRuntimeAuthProfileStoreForSave({ store, agentDir, options });
    setRuntimeAuthProfileStoreSnapshot(
      existingRuntimeStore
        ? mergeRuntimeExternalProfileReferences({
            next: nextRuntimeStore,
            existing: existingRuntimeStore,
          })
        : nextRuntimeStore,
      agentDir,
    );
  }
}
