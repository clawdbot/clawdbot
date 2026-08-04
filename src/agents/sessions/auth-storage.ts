/**
 * Credential storage facade for API keys and OAuth tokens.
 * Canonical persistence is the per-agent SQLite auth-profile store.
 *
 * The backend contract keeps the upstream session SDK shape while OpenClaw
 * projects provider-default profiles into it.
 */

import fs from "node:fs";
import { dirname } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { findEnvKeys, getEnvApiKey } from "@openclaw/ai/internal/runtime";
import { withFileLock } from "../../infra/file-lock.js";
import type {
  OAuthCredentials,
  OAuthLoginCallbacks,
  OAuthProviderId,
} from "../../llm/utils/oauth/types.js";
import { OAuthProviderConfiguredUnavailableError } from "../../plugins/provider-runtime.errors.js";
import type { OpenClawAgentDatabase } from "../../state/openclaw-agent-db.js";
import { AUTH_STORE_VERSION, OAUTH_REFRESH_LOCK_OPTIONS } from "../auth-profiles/constants.js";
import {
  assertAuthProfileMigrationReady,
  AuthProfileMigrationRequiredError,
  AuthProfileStoreUnreadableError,
} from "../auth-profiles/legacy-source-diagnostic.js";
import { resolveOAuthRefreshLockPath } from "../auth-profiles/paths.js";
import { loadPersistedAuthProfileStore } from "../auth-profiles/persisted.js";
import { getRuntimeAuthProfileStoreSnapshot } from "../auth-profiles/runtime-snapshots.js";
import {
  inspectPersistedAuthProfileStateRaw,
  inspectPersistedAuthProfileStoreRaw,
  resolveAuthProfileDatabasePath,
  runAuthProfileWriteTransaction,
} from "../auth-profiles/sqlite.js";
import { loadPersistedAuthProfileState } from "../auth-profiles/state.js";
import {
  loadAuthProfileStoreForSecretsRuntime,
  saveAuthProfileStore,
} from "../auth-profiles/store.js";
import type { AuthProfileStore } from "../auth-profiles/types.js";
import { getAgentDir } from "../config.js";
import {
  getAuthStorageOAuthProviderRegistry,
  loginAuthStorageOAuthProvider,
  resolveAuthStoragePluginOAuthCredential,
} from "./auth-storage-oauth-registry.js";
import { resolveConfigValue } from "./resolve-config-value.js";

export type ApiKeyCredential = {
  type: "api_key";
  key: string;
};

export type OAuthCredential = {
  type: "oauth";
} & OAuthCredentials;

export type TokenCredential = {
  type: "token";
  token: string;
  expires?: number;
};

export type AuthCredential = ApiKeyCredential | OAuthCredential | TokenCredential;

export type AuthStorageData = Record<string, AuthCredential>;
export { OAuthProviderConfiguredUnavailableError };
export const AUTH_STORAGE_CREATE_DEPRECATION_CODE = "AUTH_STORAGE_CREATE_DEPRECATED" as const;
export const FILE_AUTH_STORAGE_BACKEND_DEPRECATION_CODE =
  "FILE_AUTH_STORAGE_BACKEND_DEPRECATED" as const;
let authStorageCreateWarningEmitted = false;
let fileAuthStorageBackendWarningEmitted = false;

function emitAuthStorageDeprecationWarning(params: {
  message: string;
  code:
    | typeof AUTH_STORAGE_CREATE_DEPRECATION_CODE
    | typeof FILE_AUTH_STORAGE_BACKEND_DEPRECATION_CODE;
}): void {
  process.emitWarning(params.message, { code: params.code, type: "DeprecationWarning" });
}

class AuthStoragePersistenceError extends Error {
  constructor(message: string, cause: unknown) {
    super(message, { cause });
    this.name = "AuthStoragePersistenceError";
  }
}

class AuthStorageLegacyPathMigrationRequiredError extends Error {
  readonly code = "AUTH_PROFILE_MIGRATION_REQUIRED" as const;
  readonly action = "migrate to AuthStorage.forAgent(agentDir)" as const;

  constructor() {
    super(
      "Deprecated AuthStorage path contains unmigrated credentials; run openclaw doctor --fix for standard agent auth.json or migrate plugin storage to AuthStorage.forAgent(agentDir).",
    );
    this.name = "AuthStorageLegacyPathMigrationRequiredError";
  }
}

function assertDeprecatedAuthStoragePathAbsent(authPath: string | undefined): void {
  // Deprecated adapters use this path only to derive the SQLite owner and
  // never create or write it. An existing file is therefore unmigrated input.
  if (authPath && fs.existsSync(authPath)) {
    throw new AuthStorageLegacyPathMigrationRequiredError();
  }
}

export type AuthStatus = {
  configured: boolean;
  source?:
    | "stored"
    | "runtime"
    | "environment"
    | "fallback"
    | "models_json_key"
    | "models_json_command";
  label?: string;
};

type LockResult<T> = {
  result: T;
  next?: string;
};

export interface AuthStorageBackend {
  readonly migrationOwnerAgentDir?: string;
  withLock<T>(fn: (current: string | undefined) => LockResult<T>): T;
  withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T>;
}

function projectAuthStorageData(store: AuthProfileStore | null): AuthStorageData {
  const projected: AuthStorageData = {};
  for (const [profileId, credential] of Object.entries(store?.profiles ?? {})) {
    if (profileId !== `${credential.provider}:default`) {
      continue;
    }
    if (credential.type === "api_key" && credential.key) {
      projected[credential.provider] = { type: "api_key", key: credential.key };
    } else if (credential.type === "token" && credential.token) {
      projected[credential.provider] = {
        type: "token",
        token: credential.token,
        ...(credential.expires !== undefined ? { expires: credential.expires } : {}),
      };
    } else if (credential.type === "oauth") {
      projected[credential.provider] = { ...credential };
    }
  }
  return projected;
}

function assertAuthStorageSecretRefsMaterialized(store: AuthProfileStore): void {
  for (const [profileId, credential] of Object.entries(store.profiles)) {
    if (profileId !== `${credential.provider}:default`) {
      continue;
    }
    if (
      (credential.type === "api_key" && credential.keyRef && !credential.key) ||
      (credential.type === "token" && credential.tokenRef && !credential.token)
    ) {
      throw new AuthStoragePersistenceError(
        "AuthStorage.forAgent requires the active secrets runtime to materialize SecretRef credentials.",
        undefined,
      );
    }
  }
}

function projectAuthoritativeAuthStorageData(
  store: AuthProfileStore,
  snapshots: readonly AuthProfileStore[],
): AuthStorageData {
  if (snapshots.length === 0) {
    assertAuthStorageSecretRefsMaterialized(store);
    return projectAuthStorageData(store);
  }
  const profiles = Object.fromEntries(
    Object.entries(store.profiles).map(([profileId, credential]) => {
      const runtimeCredential = snapshots
        .map((snapshot) => snapshot.profiles[profileId])
        .find((candidate) =>
          credential.type === "api_key" && credential.keyRef
            ? candidate?.type === "api_key" &&
              Boolean(candidate.key) &&
              candidate.provider === credential.provider &&
              isDeepStrictEqual(candidate.keyRef, credential.keyRef)
            : credential.type === "token" && credential.tokenRef
              ? candidate?.type === "token" &&
                Boolean(candidate.token) &&
                candidate.provider === credential.provider &&
                isDeepStrictEqual(candidate.tokenRef, credential.tokenRef)
              : false,
        );
      const needsMaterializedRef =
        (credential.type === "api_key" && Boolean(credential.keyRef)) ||
        (credential.type === "token" && Boolean(credential.tokenRef));
      return [
        profileId,
        needsMaterializedRef && runtimeCredential ? runtimeCredential : credential,
      ];
    }),
  );
  const materialized = { ...store, profiles };
  assertAuthStorageSecretRefsMaterialized(materialized);
  return projectAuthStorageData(materialized);
}

function applyAuthStorageData(
  store: AuthProfileStore,
  data: AuthStorageData,
  materializedBaseline: AuthStorageData,
): AuthProfileStore {
  const profiles = { ...store.profiles };
  const projectedProviders = new Set([
    ...Object.keys(materializedBaseline),
    ...Object.entries(store.profiles).flatMap(([profileId, credential]) =>
      profileId === `${credential.provider}:default` ? [credential.provider] : [],
    ),
  ]);
  for (const provider of projectedProviders) {
    if (!data[provider]) {
      delete profiles[`${provider}:default`];
    }
  }
  for (const [provider, credential] of Object.entries(data)) {
    const profileId = `${provider}:default`;
    const existing = profiles[profileId];
    if (
      credential.type === "api_key" &&
      existing?.type === "api_key" &&
      existing.keyRef &&
      materializedBaseline[provider]?.type === "api_key" &&
      materializedBaseline[provider].key === credential.key
    ) {
      profiles[profileId] = existing;
      continue;
    }
    if (
      credential.type === "token" &&
      existing?.type === "token" &&
      existing.tokenRef &&
      materializedBaseline[provider]?.type === "token" &&
      materializedBaseline[provider].token === credential.token
    ) {
      profiles[profileId] = existing;
      continue;
    }
    profiles[profileId] =
      credential.type === "api_key"
        ? { type: "api_key", provider, key: credential.key }
        : credential.type === "token"
          ? { type: "token", provider, token: credential.token, expires: credential.expires }
          : { ...credential, provider };
  }
  return { ...store, profiles };
}

function collectStateOnlyAuthProfileIds(store: AuthProfileStore): string[] {
  const referenced = new Set([
    ...Object.values(store.order ?? {}).flat(),
    ...Object.values(store.lastGood ?? {}),
    ...Object.keys(store.usageStats ?? {}),
  ]);
  return [...referenced].filter((profileId) => !store.profiles[profileId]);
}

function loadSqliteAuthStorageStore(
  agentDir: string,
  database?: OpenClawAgentDatabase,
): AuthProfileStore {
  const inspection = inspectPersistedAuthProfileStoreRaw(agentDir, database);
  if (inspection.status === "missing") {
    const stateInspection = inspectPersistedAuthProfileStateRaw(agentDir, database);
    if (stateInspection.status === "unreadable") {
      throw new AuthProfileStoreUnreadableError(agentDir);
    }
    return {
      version: AUTH_STORE_VERSION,
      profiles: {},
      ...loadPersistedAuthProfileState(agentDir, database),
    };
  }
  const store = loadPersistedAuthProfileStore(agentDir, database ? { database } : undefined);
  if (inspection.status === "unreadable" || !store) {
    throw new AuthProfileStoreUnreadableError(agentDir);
  }
  return store;
}

class SqliteAuthStorageBackend implements AuthStorageBackend {
  constructor(
    private readonly agentDir: string,
    private preparedStore?: AuthProfileStore,
  ) {}

  private resolveMaterializedRuntimeStores(): AuthProfileStore[] {
    const current = getRuntimeAuthProfileStoreSnapshot(this.agentDir);
    // A current lifecycle snapshot is authoritative, including an unresolved
    // ref after failed/revoked secrets reload. Prepared data is bootstrap-only.
    return current ? [current] : this.preparedStore ? [this.preparedStore] : [];
  }

  private readRaw(): AuthProfileStore {
    assertAuthProfileMigrationReady(this.agentDir);
    return loadSqliteAuthStorageStore(this.agentDir);
  }

  withLock<T>(fn: (current: string | undefined) => LockResult<T>): T {
    assertAuthProfileMigrationReady(this.agentDir);
    const snapshots = this.resolveMaterializedRuntimeStores();
    assertAuthProfileMigrationReady(this.agentDir);
    return runAuthProfileWriteTransaction(this.agentDir, (database) => {
      const store = loadSqliteAuthStorageStore(this.agentDir, database);
      const materializedData = projectAuthoritativeAuthStorageData(store, snapshots);
      const { result, next } = fn(JSON.stringify(materializedData));
      if (next !== undefined) {
        saveAuthProfileStore(
          applyAuthStorageData(store, JSON.parse(next) as AuthStorageData, materializedData),
          this.agentDir,
          {
            filterExternalAuthProfiles: false,
            preserveStateProfileIds: collectStateOnlyAuthProfileIds(store),
            syncExternalCli: false,
          },
          database,
        );
      }
      return result;
    });
  }

  async withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T> {
    assertAuthProfileMigrationReady(this.agentDir);
    return await withFileLock(
      resolveAuthProfileDatabasePath(this.agentDir),
      OAUTH_REFRESH_LOCK_OPTIONS,
      async () => {
        const initialRaw = this.readRaw();
        const initialData = projectAuthoritativeAuthStorageData(
          initialRaw,
          this.resolveMaterializedRuntimeStores(),
        );
        const { result, next } = await fn(JSON.stringify(initialData));
        if (next === undefined) {
          return result;
        }
        assertAuthProfileMigrationReady(this.agentDir);
        runAuthProfileWriteTransaction(this.agentDir, (database) => {
          const authoritative = loadSqliteAuthStorageStore(this.agentDir, database);
          if (!isDeepStrictEqual(authoritative.profiles, initialRaw.profiles)) {
            throw new AuthStoragePersistenceError(
              "Cannot update auth storage because its SQLite credentials changed concurrently.",
              undefined,
            );
          }
          saveAuthProfileStore(
            applyAuthStorageData(authoritative, JSON.parse(next) as AuthStorageData, initialData),
            this.agentDir,
            {
              filterExternalAuthProfiles: false,
              preserveStateProfileIds: collectStateOnlyAuthProfileIds(authoritative),
              syncExternalCli: false,
            },
            database,
          );
        });
        return result;
      },
    );
  }
}

/**
 * @deprecated Use AuthStorage.forAgent(agentDir). This compatibility adapter
 * derives the owning agent directory from the old path and persists only to SQLite.
 * It is eligible for removal after 2026-10-01 and a clean published-plugin sweep.
 */
export class FileAuthStorageBackend implements AuthStorageBackend {
  private readonly delegate: SqliteAuthStorageBackend;
  readonly migrationOwnerAgentDir: string;

  constructor(authPath?: string) {
    if (!fileAuthStorageBackendWarningEmitted) {
      fileAuthStorageBackendWarningEmitted = true;
      emitAuthStorageDeprecationWarning({
        code: FILE_AUTH_STORAGE_BACKEND_DEPRECATION_CODE,
        message:
          "FileAuthStorageBackend(path) is deprecated; use AuthStorage.forAgent(agentDir). The compatibility adapter persists to SQLite and never reads or writes auth.json.",
      });
    }
    assertDeprecatedAuthStoragePathAbsent(authPath);
    this.migrationOwnerAgentDir = authPath ? dirname(authPath) : getAgentDir();
    this.delegate = new SqliteAuthStorageBackend(this.migrationOwnerAgentDir);
  }

  withLock<T>(fn: (current: string | undefined) => LockResult<T>): T {
    return this.delegate.withLock(fn);
  }

  async withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T> {
    return await this.delegate.withLockAsync(fn);
  }
}

export class InMemoryAuthStorageBackend implements AuthStorageBackend {
  private value: string | undefined;

  withLock<T>(fn: (current: string | undefined) => LockResult<T>): T {
    const { result, next } = fn(this.value);
    if (next !== undefined) {
      this.value = next;
    }
    return result;
  }

  async withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T> {
    const { result, next } = await fn(this.value);
    if (next !== undefined) {
      this.value = next;
    }
    return result;
  }
}

/**
 * Provider-keyed credential facade backed by the canonical auth-profile store.
 */
export class AuthStorage {
  private data: AuthStorageData = {};
  private runtimeOverrides: Map<string, string> = new Map();
  private fallbackResolver?: (provider: string) => string | undefined;
  private loadError: Error | null = null;
  private errors: Error[] = [];
  private storage: AuthStorageBackend;
  private migrationOwnerAgentDir?: string;

  private constructor(storage: AuthStorageBackend, migrationOwnerAgentDir?: string) {
    this.storage = storage;
    this.migrationOwnerAgentDir = migrationOwnerAgentDir ?? storage.migrationOwnerAgentDir;
    this.reload();
  }

  static forAgent(agentDir: string = getAgentDir()): AuthStorage {
    assertAuthProfileMigrationReady(agentDir);
    const preparedStore =
      getRuntimeAuthProfileStoreSnapshot(agentDir) ??
      loadAuthProfileStoreForSecretsRuntime(agentDir);
    assertAuthStorageSecretRefsMaterialized(preparedStore);
    return new AuthStorage(new SqliteAuthStorageBackend(agentDir, preparedStore), agentDir);
  }

  /**
   * @deprecated Use AuthStorage.forAgent(agentDir). The path-taking compatibility
   * form is eligible for removal after 2026-10-01 and a clean published-plugin
   * reader sweep; it no longer reads or writes JSON.
   */
  static create(authPath?: string): AuthStorage {
    if (!authStorageCreateWarningEmitted) {
      authStorageCreateWarningEmitted = true;
      emitAuthStorageDeprecationWarning({
        code: AUTH_STORAGE_CREATE_DEPRECATION_CODE,
        message:
          "AuthStorage.create(path) is deprecated; use AuthStorage.forAgent(agentDir). The compatibility adapter persists to SQLite and never reads or writes auth.json.",
      });
    }
    assertDeprecatedAuthStoragePathAbsent(authPath);
    return AuthStorage.forAgent(authPath ? dirname(authPath) : getAgentDir());
  }

  static fromStorage(storage: AuthStorageBackend): AuthStorage {
    return new AuthStorage(storage);
  }

  static inMemory(data: AuthStorageData = {}): AuthStorage {
    const storage = new InMemoryAuthStorageBackend();
    storage.withLock(() => ({ result: undefined, next: JSON.stringify(data, null, 2) }));
    return AuthStorage.fromStorage(storage);
  }

  /**
   * Set a runtime API key override (not persisted to disk).
   * Used for CLI --api-key flag.
   */
  setRuntimeApiKey(provider: string, apiKey: string): void {
    this.runtimeOverrides.set(provider, apiKey);
  }

  /**
   * Remove a runtime API key override.
   */
  removeRuntimeApiKey(provider: string): void {
    this.runtimeOverrides.delete(provider);
  }

  /**
   * Set a fallback resolver for API keys not found in auth.json or env vars.
   * Used for custom provider keys from models.json.
   */
  setFallbackResolver(resolver: (provider: string) => string | undefined): void {
    this.fallbackResolver = resolver;
  }

  private recordError(error: unknown): void {
    const normalizedError = error instanceof Error ? error : new Error(String(error));
    this.errors.push(normalizedError);
  }

  private getCanonicalLoadError(): Error | null {
    if (!this.loadError) {
      return null;
    }
    return this.migrationOwnerAgentDir ||
      this.loadError instanceof AuthProfileMigrationRequiredError ||
      this.loadError instanceof AuthProfileStoreUnreadableError
      ? this.loadError
      : null;
  }

  private parseStorageData(content: string | undefined): AuthStorageData {
    if (!content) {
      return {};
    }
    return JSON.parse(content) as AuthStorageData;
  }

  /**
   * Reload credentials from storage.
   */
  reload(): void {
    let content: string | undefined;
    try {
      this.storage.withLock((current) => {
        content = current;
        return { result: undefined };
      });
      this.data = this.parseStorageData(content);
      this.loadError = null;
    } catch (error) {
      this.loadError = error as Error;
      this.recordError(error);
    }
  }

  private persistProviderChange(provider: string, credential: AuthCredential | undefined): void {
    if (this.loadError) {
      this.reload();
    }

    if (this.loadError) {
      const error = new AuthStoragePersistenceError(
        `Cannot update auth storage because it could not be loaded: ${this.loadError.message}`,
        this.loadError,
      );
      this.recordError(error);
      throw error;
    }

    try {
      const persistedData = this.storage.withLock((current) => {
        const currentData = this.parseStorageData(current);
        const merged: AuthStorageData = { ...currentData };
        if (credential) {
          merged[provider] = credential;
        } else {
          delete merged[provider];
        }
        return { result: merged, next: JSON.stringify(merged, null, 2) };
      });
      this.loadError = null;
      this.data = persistedData;
    } catch (error) {
      const persistenceError =
        error instanceof AuthStoragePersistenceError
          ? error
          : new AuthStoragePersistenceError(
              `Failed to persist auth storage update for provider "${provider}": ${error instanceof Error ? error.message : String(error)}`,
              error,
            );
      this.recordError(persistenceError);
      throw persistenceError;
    }
  }

  /**
   * Get credential for a provider.
   */
  get(provider: string): AuthCredential | undefined {
    return this.data[provider] ?? undefined;
  }

  /**
   * Set credential for a provider.
   */
  set(provider: string, credential: AuthCredential): void {
    this.persistProviderChange(provider, credential);
  }

  /**
   * Remove credential for a provider.
   */
  remove(provider: string): void {
    this.persistProviderChange(provider, undefined);
  }

  /**
   * List all providers with credentials.
   */
  list(): string[] {
    return Object.keys(this.data);
  }

  /**
   * Check if credentials exist for a provider in auth.json.
   */
  has(provider: string): boolean {
    return provider in this.data;
  }

  /**
   * Check if any form of auth is configured for a provider.
   * Unlike getApiKey(), this doesn't refresh OAuth tokens.
   */
  hasAuth(provider: string): boolean {
    if (this.runtimeOverrides.has(provider)) {
      return true;
    }
    if (this.data[provider]) {
      return true;
    }
    if (getEnvApiKey(provider)) {
      return true;
    }
    if (this.fallbackResolver?.(provider)) {
      return true;
    }
    return false;
  }

  /**
   * Return auth status without exposing credential values or refreshing tokens.
   */
  getAuthStatus(provider: string): AuthStatus {
    if (this.data[provider]) {
      return { configured: true, source: "stored" };
    }

    if (this.runtimeOverrides.has(provider)) {
      return { configured: false, source: "runtime", label: "--api-key" };
    }

    const envKeys = findEnvKeys(provider);
    if (envKeys?.[0]) {
      return { configured: false, source: "environment", label: envKeys[0] };
    }

    if (this.fallbackResolver?.(provider)) {
      return { configured: false, source: "fallback", label: "custom provider config" };
    }

    return { configured: false };
  }

  /**
   * Get all credentials (for passing to getOAuthApiKey).
   */
  getAll(): AuthStorageData {
    return { ...this.data };
  }

  drainErrors(): Error[] {
    const drained = [...this.errors];
    this.errors = [];
    return drained;
  }

  /**
   * Login to an OAuth provider.
   */
  async login(providerId: OAuthProviderId, callbacks: OAuthLoginCallbacks): Promise<void> {
    const credentials = await loginAuthStorageOAuthProvider(this, providerId, callbacks);
    this.set(providerId, { type: "oauth", ...credentials });
  }

  /**
   * Logout from a provider.
   */
  logout(provider: string): void {
    this.remove(provider);
  }

  /**
   * Refresh OAuth token with backend locking to prevent race conditions.
   * Multiple agent sessions may try to refresh simultaneously when tokens expire.
   */
  private async refreshOAuthTokenWithLock(
    providerId: OAuthProviderId,
  ): Promise<{ apiKey: string; newCredentials: OAuthCredentials } | null> {
    const provider = getAuthStorageOAuthProviderRegistry(this).get(providerId);

    const refresh = async () =>
      await this.storage.withLockAsync(async (current) => {
        const currentData = this.parseStorageData(current);
        this.data = currentData;
        this.loadError = null;

        const cred = currentData[providerId];
        if (cred?.type !== "oauth") {
          return { result: null };
        }

        if (Date.now() < cred.expires) {
          if (provider) {
            return { result: { apiKey: provider.getApiKey(cred), newCredentials: cred } };
          }
          return { result: await resolveAuthStoragePluginOAuthCredential(providerId, cred, false) };
        }

        const oauthCreds: Record<string, OAuthCredentials> = {};
        for (const [key, value] of Object.entries(currentData)) {
          if (value.type === "oauth") {
            oauthCreds[key] = value;
          }
        }

        const refreshed = provider
          ? await getAuthStorageOAuthProviderRegistry(this).getApiKey(providerId, oauthCreds)
          : await resolveAuthStoragePluginOAuthCredential(providerId, cred, true);
        if (!refreshed) {
          return { result: null };
        }

        const refreshedCredential: OAuthCredential = {
          type: "oauth",
          ...refreshed.newCredentials,
        };
        const merged: AuthStorageData = {
          ...currentData,
          [providerId]: refreshedCredential,
        };
        this.data = merged;
        this.loadError = null;
        return { result: refreshed, next: JSON.stringify(merged, null, 2) };
      });

    const result = this.migrationOwnerAgentDir
      ? await withFileLock(
          resolveOAuthRefreshLockPath(providerId, `${providerId}:default`),
          OAUTH_REFRESH_LOCK_OPTIONS,
          refresh,
        )
      : await refresh();

    return result;
  }

  /**
   * Get API key for a provider.
   * Priority:
   * 1. Runtime override (CLI --api-key)
   * 2. API key from auth.json
   * 3. OAuth token from auth.json (auto-refreshed with locking)
   * 4. Environment variable
   * 5. Fallback resolver (models.json custom providers)
   */
  async getApiKey(
    providerId: string,
    options?: { includeFallback?: boolean },
  ): Promise<string | undefined> {
    // Runtime override takes highest priority
    const runtimeKey = this.runtimeOverrides.get(providerId);
    if (runtimeKey) {
      return runtimeKey;
    }

    if (this.migrationOwnerAgentDir) {
      assertAuthProfileMigrationReady(this.migrationOwnerAgentDir);
    }

    const canonicalLoadError = this.getCanonicalLoadError();
    if (canonicalLoadError) {
      // Canonical-store ownership blocks implicit env/config fallback. An
      // explicit runtime override above remains the only caller-owned escape.
      throw canonicalLoadError;
    }

    const cred = this.data[providerId];

    if (cred?.type === "api_key") {
      return resolveConfigValue(cred.key);
    }

    if (cred?.type === "token") {
      if (cred.expires === undefined || Date.now() < cred.expires) {
        return resolveConfigValue(cred.token);
      }
    }

    if (cred?.type === "oauth") {
      const provider = getAuthStorageOAuthProviderRegistry(this).get(providerId);

      // Check if token needs refresh
      const needsRefresh = Date.now() >= cred.expires;

      if (needsRefresh) {
        // Use locked refresh to prevent race conditions
        try {
          const result = await this.refreshOAuthTokenWithLock(providerId);
          if (result) {
            return result.apiKey;
          }
        } catch (error) {
          if (error instanceof OAuthProviderConfiguredUnavailableError) {
            throw error;
          }
          this.recordError(error);
          // Refresh failed - re-read file to check if another instance succeeded
          this.reload();
          const canonicalStoreError =
            error instanceof AuthProfileMigrationRequiredError ||
            error instanceof AuthProfileStoreUnreadableError
              ? error
              : this.getCanonicalLoadError();
          if (canonicalStoreError) {
            throw canonicalStoreError;
          }
          const updatedCred = this.data[providerId];

          if (updatedCred?.type === "oauth" && Date.now() < updatedCred.expires) {
            // Another instance refreshed successfully, use those credentials
            if (provider) {
              return provider.getApiKey(updatedCred);
            }
            return (await resolveAuthStoragePluginOAuthCredential(providerId, updatedCred, false))
              ?.apiKey;
          }

          // Refresh truly failed - return undefined so model discovery skips this provider
          // User can /login to re-authenticate (credentials preserved for retry)
          return undefined;
        }
      } else {
        if (provider) {
          return provider.getApiKey(cred);
        }
        return (await resolveAuthStoragePluginOAuthCredential(providerId, cred, false))?.apiKey;
      }
    }

    // Fall back to environment variable
    const envKey = getEnvApiKey(providerId);
    if (envKey) {
      return envKey;
    }

    // Fall back to custom resolver (e.g., models.json custom providers)
    if (options?.includeFallback !== false) {
      return this.fallbackResolver?.(providerId) ?? undefined;
    }

    return undefined;
  }

  /**
   * Get all OAuth providers registered for this auth/session runtime.
   */
  getOAuthProviders() {
    return getAuthStorageOAuthProviderRegistry(this).getAll();
  }
}
