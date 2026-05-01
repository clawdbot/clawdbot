import fs from "node:fs";
import { isDeepStrictEqual } from "node:util";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { withFileLock } from "../../infra/file-lock.js";
import { saveJsonFile } from "../../infra/json-file.js";
import {
  AUTH_STORE_LOCK_OPTIONS,
  AUTH_STORE_VERSION,
  EXTERNAL_CLI_SYNC_TTL_MS,
  log,
} from "./constants.js";
import { overlayExternalAuthProfiles, shouldPersistExternalAuthProfile } from "./external-auth.js";
import type { ExternalCliAuthDiscovery } from "./external-cli-discovery.js";
import { isSafeToAdoptMainStoreOAuthIdentity } from "./oauth-shared.js";
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
  getRuntimeAuthProfileStoreSnapshot,
  hasRuntimeAuthProfileStoreSnapshot,
  replaceRuntimeAuthProfileStoreSnapshots as replaceRuntimeAuthProfileStoreSnapshotsImpl,
  setRuntimeAuthProfileStoreSnapshot,
} from "./runtime-snapshots.js";
import { savePersistedAuthProfileState } from "./state.js";
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

type ResolvedExternalCliOverlayOptions = {
  allowKeychainPrompt?: boolean;
  config?: OpenClawConfig;
  externalCliProviderIds?: Iterable<string>;
  externalCliProfileIds?: Iterable<string>;
};

const loadedAuthStoreCache = new Map<
  string,
  {
    authMtimeMs: number | null;
    stateMtimeMs: number | null;
    syncedAtMs: number;
    store: AuthProfileStore;
  }
>();

function cloneAuthProfileStore(store: AuthProfileStore): AuthProfileStore {
  return structuredClone(store);
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
  return (
    Number.isFinite(params.main.expires) &&
    (!Number.isFinite(params.local.expires) || params.main.expires >= params.local.expires)
  );
}

function resolveRuntimeAuthProfileStore(agentDir?: string): AuthProfileStore | null {
  const mainKey = resolveAuthStorePath(undefined);
  const requestedKey = resolveAuthStorePath(agentDir);
  const mainStore = getRuntimeAuthProfileStoreSnapshot(undefined);
  const requestedStore = getRuntimeAuthProfileStoreSnapshot(agentDir);

  if (!agentDir || requestedKey === mainKey) {
    if (!mainStore) {
      return null;
    }
    return mainStore;
  }

  if (mainStore && requestedStore) {
    return mergeAuthProfileStores(mainStore, requestedStore);
  }
  if (requestedStore) {
    const persistedMainStore = loadAuthProfileStoreForAgent(undefined, {
      readOnly: true,
      syncExternalCli: false,
    });
    return mergeAuthProfileStores(persistedMainStore, requestedStore);
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

function readCachedAuthProfileStore(params: {
  authPath: string;
  authMtimeMs: number | null;
  stateMtimeMs: number | null;
}): AuthProfileStore | null {
  const cached = loadedAuthStoreCache.get(params.authPath);
  if (
    !cached ||
    cached.authMtimeMs !== params.authMtimeMs ||
    cached.stateMtimeMs !== params.stateMtimeMs
  ) {
    return null;
  }
  if (Date.now() - cached.syncedAtMs >= EXTERNAL_CLI_SYNC_TTL_MS) {
    return null;
  }
  return cloneAuthProfileStore(cached.store);
}

function writeCachedAuthProfileStore(params: {
  authPath: string;
  authMtimeMs: number | null;
  stateMtimeMs: number | null;
  store: AuthProfileStore;
}): void {
  loadedAuthStoreCache.set(params.authPath, {
    authMtimeMs: params.authMtimeMs,
    stateMtimeMs: params.stateMtimeMs,
    syncedAtMs: Date.now(),
    store: cloneAuthProfileStore(params.store),
  });
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

function shouldKeepProfileInLocalStore(params: {
  store: AuthProfileStore;
  profileId: string;
  credential: AuthProfileStore["profiles"][string];
  agentDir?: string;
  options?: SaveAuthProfileStoreOptions;
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
  return shouldPersistExternalAuthProfile({
    store: params.store,
    profileId: params.profileId,
    credential: params.credential,
    agentDir: params.agentDir,
  });
}

function buildLocalAuthProfileStoreForSave(params: {
  store: AuthProfileStore;
  agentDir?: string;
  options?: SaveAuthProfileStoreOptions;
}): AuthProfileStore {
  const localStore = cloneAuthProfileStore(params.store);
  localStore.profiles = Object.fromEntries(
    Object.entries(localStore.profiles).filter(([profileId, credential]) =>
      shouldKeepProfileInLocalStore({
        store: params.store,
        profileId,
        credential,
        agentDir: params.agentDir,
        options: params.options,
      }),
    ),
  );
  const keptProfileIds = new Set(Object.keys(localStore.profiles));
  localStore.order = localStore.order
    ? Object.fromEntries(
        Object.entries(localStore.order)
          .map(([provider, profileIds]) => [
            provider,
            profileIds.filter((profileId) => keptProfileIds.has(profileId)),
          ])
          .filter(([, profileIds]) => profileIds.length > 0),
      )
    : undefined;
  localStore.lastGood = localStore.lastGood
    ? Object.fromEntries(
        Object.entries(localStore.lastGood).filter(([, profileId]) =>
          keptProfileIds.has(profileId),
        ),
      )
    : undefined;
  localStore.usageStats = localStore.usageStats
    ? Object.fromEntries(
        Object.entries(localStore.usageStats).filter(([profileId]) =>
          keptProfileIds.has(profileId),
        ),
      )
    : undefined;
  return localStore;
}

export async function updateAuthProfileStoreWithLock(params: {
  agentDir?: string;
  updater: (store: AuthProfileStore) => boolean;
}): Promise<AuthProfileStore | null> {
  const authPath = resolveAuthStorePath(params.agentDir);
  ensureAuthStoreFile(authPath);

  try {
    return await withFileLock(authPath, AUTH_STORE_LOCK_OPTIONS, async () => {
      // Locked writers must reload from disk, not from any runtime snapshot.
      // Otherwise a live gateway can overwrite fresher CLI/config-auth writes
      // with stale in-memory auth state during usage/cooldown updates.
      const store = loadAuthProfileStoreForAgent(params.agentDir);
      const shouldSave = params.updater(store);
      if (shouldSave) {
        saveAuthProfileStore(store, params.agentDir);
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
  const asStore = loadPersistedAuthProfileStore(agentDir);
  if (asStore) {
    if (!readOnly) {
      writeCachedAuthProfileStore({
        authPath,
        authMtimeMs: readAuthStoreMtimeMs(authPath),
        stateMtimeMs: readAuthStoreMtimeMs(statePath),
        store: asStore,
      });
    }
    return asStore;
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

  if (!readOnly) {
    writeCachedAuthProfileStore({
      authPath,
      authMtimeMs: readAuthStoreMtimeMs(authPath),
      stateMtimeMs: readAuthStoreMtimeMs(statePath),
      store,
    });
  }
  return store;
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
  return overlayExternalAuthProfiles(mergeAuthProfileStores(mainStore, store), {
    agentDir,
    ...externalCli,
  });
}

export function loadAuthProfileStoreForSecretsRuntime(agentDir?: string): AuthProfileStore {
  return loadAuthProfileStoreForRuntime(agentDir, { readOnly: true, allowKeychainPrompt: false });
}

export function loadAuthProfileStoreWithoutExternalProfiles(agentDir?: string): AuthProfileStore {
  const options: LoadAuthProfileStoreOptions = { readOnly: true, allowKeychainPrompt: false };
  const store = loadAuthProfileStoreForAgent(agentDir, options);
  const authPath = resolveAuthStorePath(agentDir);
  const mainAuthPath = resolveAuthStorePath();
  if (!agentDir || authPath === mainAuthPath) {
    return store;
  }

  const mainStore = loadAuthProfileStoreForAgent(undefined, options);
  return mergeAuthProfileStores(mainStore, store);
}

export function ensureAuthProfileStore(
  agentDir?: string,
  options?: {
    allowKeychainPrompt?: boolean;
    config?: OpenClawConfig;
    externalCli?: ExternalCliAuthDiscovery;
    externalCliProviderIds?: Iterable<string>;
    externalCliProfileIds?: Iterable<string>;
  },
): AuthProfileStore {
  const externalCli = resolveExternalCliOverlayOptions(options);
  return overlayExternalAuthProfiles(
    ensureAuthProfileStoreWithoutExternalProfiles(agentDir, options),
    {
      agentDir,
      ...externalCli,
    },
  );
}

export function ensureAuthProfileStoreWithoutExternalProfiles(
  agentDir?: string,
  options?: { allowKeychainPrompt?: boolean },
): AuthProfileStore {
  const runtimeStore = resolveRuntimeAuthProfileStore(agentDir);
  if (runtimeStore) {
    return runtimeStore;
  }
  const store = loadAuthProfileStoreForAgent(agentDir, options);
  const authPath = resolveAuthStorePath(agentDir);
  const mainAuthPath = resolveAuthStorePath();
  if (!agentDir || authPath === mainAuthPath) {
    return store;
  }

  const mainStore = loadAuthProfileStoreForAgent(undefined, options);
  return mergeAuthProfileStores(mainStore, store);
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
  return mergeAuthProfileStores(mainStore, store);
}

export { hasAnyAuthProfileStoreSource } from "./source-check.js";

export function replaceRuntimeAuthProfileStoreSnapshots(
  entries: Array<{ agentDir?: string; store: AuthProfileStore }>,
): void {
  replaceRuntimeAuthProfileStoreSnapshotsImpl(entries);
}

export function clearRuntimeAuthProfileStoreSnapshots(): void {
  clearRuntimeAuthProfileStoreSnapshotsImpl();
  loadedAuthStoreCache.clear();
}

export function saveAuthProfileStore(
  store: AuthProfileStore,
  agentDir?: string,
  options?: SaveAuthProfileStoreOptions,
): void {
  const authPath = resolveAuthStorePath(agentDir);
  const statePath = resolveAuthStatePath(agentDir);
  const localStore = buildLocalAuthProfileStoreForSave({ store, agentDir, options });
  const payload = buildPersistedAuthProfileSecretsStore(localStore);
  saveJsonFile(authPath, payload);
  savePersistedAuthProfileState(localStore, agentDir);
  writeCachedAuthProfileStore({
    authPath,
    authMtimeMs: readAuthStoreMtimeMs(authPath),
    stateMtimeMs: readAuthStoreMtimeMs(statePath),
    store: localStore,
  });
  if (hasRuntimeAuthProfileStoreSnapshot(agentDir)) {
    setRuntimeAuthProfileStoreSnapshot(localStore, agentDir);
  }
}
