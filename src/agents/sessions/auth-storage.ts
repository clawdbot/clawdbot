/**
 * Credential storage for API keys and OAuth tokens.
 * Handles loading, saving, and refreshing credentials from auth.json.
 *
 * Uses file locking to prevent race conditions when multiple agent sessions
 * try to refresh tokens simultaneously.
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { findEnvKeys, getEnvApiKey } from "@openclaw/ai/internal/runtime";
import lockfile from "proper-lockfile";
import { replaceFileAtomicSync } from "../../infra/replace-file.js";
import {
  getOAuthApiKey,
  getOAuthProvider,
  getOAuthProviders,
} from "../../llm/utils/oauth/index.js";
import type {
  OAuthCredentials,
  OAuthLoginCallbacks,
  OAuthProviderId,
} from "../../llm/utils/oauth/types.js";
import { getAgentDir } from "../config.js";
import { resolveConfigValue } from "./resolve-config-value.js";
import { acquireLockSyncWithRetry } from "./storage-lock.js";

export type ApiKeyCredential = {
  type: "api_key";
  key: string;
};

export type OAuthCredential = {
  type: "oauth";
} & OAuthCredentials;

export type AuthCredential = ApiKeyCredential | OAuthCredential;

export type AuthStorageData = Record<string, AuthCredential>;

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
  withLock<T>(fn: (current: string | undefined) => LockResult<T>): T;
  withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T>;
}

export class FileAuthStorageBackend implements AuthStorageBackend {
  private authPath: string;

  constructor(authPath: string = join(getAgentDir(), "auth.json")) {
    this.authPath = authPath;
  }

  private ensureParentDir(): void {
    const dir = dirname(this.authPath);
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
    }
  }

  private ensureFileExists(): void {
    if (!existsSync(this.authPath)) {
      writeFileSync(this.authPath, "{}", "utf-8");
      chmodSync(this.authPath, 0o600);
    }
  }

  private replaceAuthFileAtomic(content: string): void {
    const dirMode = statSync(dirname(this.authPath)).mode & 0o7777;
    replaceFileAtomicSync({
      filePath: this.authPath,
      content,
      dirMode,
      mode: 0o600,
      tempPrefix: "auth.json",
      syncTempFile: true,
      syncParentDir: true,
    });
  }

  withLock<T>(fn: (current: string | undefined) => LockResult<T>): T {
    this.ensureParentDir();
    this.ensureFileExists();

    const release = acquireLockSyncWithRetry(this.authPath);
    try {
      const current = existsSync(this.authPath) ? readFileSync(this.authPath, "utf-8") : undefined;
      const { result, next } = fn(current);
      if (next !== undefined) {
        this.replaceAuthFileAtomic(next);
      }
      return result;
    } finally {
      release();
    }
  }

  async withLockAsync<T>(fn: (current: string | undefined) => Promise<LockResult<T>>): Promise<T> {
    this.ensureParentDir();
    this.ensureFileExists();

    let lockCompromisedError: Error | undefined;
    const release = await lockfile.lock(this.authPath, {
      retries: {
        minTimeout: 100,
        maxTimeout: 10000,
        randomize: true,
      },
      stale: 30000,
      onCompromised: (err) => {
        lockCompromisedError = err;
      },
    });
    try {
      const current = existsSync(this.authPath) ? readFileSync(this.authPath, "utf-8") : undefined;
      const { result, next } = await fn(current);
      if (lockCompromisedError) {
        throw lockCompromisedError;
      }
      if (next !== undefined) {
        this.replaceAuthFileAtomic(next);
      }
      return result;
    } finally {
      if (!lockCompromisedError) {
        await release();
      }
    }
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
 * Credential storage backed by a JSON file.
 */
export class AuthStorage {
  private data: AuthStorageData = {};
  private runtimeOverrides: Map<string, string> = new Map();
  private fallbackResolver?: (provider: string) => string | undefined;
  private loadError: Error | null = null;
  private errors: Error[] = [];
  private storage: AuthStorageBackend;

  private constructor(storage: AuthStorageBackend) {
    this.storage = storage;
    this.reload();
  }

  static create(authPath?: string): AuthStorage {
    return new AuthStorage(
      new FileAuthStorageBackend(authPath ?? join(getAgentDir(), "auth.json")),
    );
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
      return;
    }

    try {
      this.storage.withLock((current) => {
        const currentData = this.parseStorageData(current);
        const merged: AuthStorageData = { ...currentData };
        if (credential) {
          merged[provider] = credential;
        } else {
          delete merged[provider];
        }
        return { result: undefined, next: JSON.stringify(merged, null, 2) };
      });
    } catch (error) {
      this.recordError(error);
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
    this.data[provider] = credential;
    this.persistProviderChange(provider, credential);
  }

  /**
   * Remove credential for a provider.
   */
  remove(provider: string): void {
    delete this.data[provider];
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
    const provider = getOAuthProvider(providerId);
    if (!provider) {
      throw new Error(`Unknown OAuth provider: ${providerId}`);
    }

    const credentials = await provider.login(callbacks);
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
    const provider = getOAuthProvider(providerId);
    if (!provider) {
      return null;
    }

    const result = await this.storage.withLockAsync(async (current) => {
      const currentData = this.parseStorageData(current);
      this.data = currentData;
      this.loadError = null;

      const cred = currentData[providerId];
      if (cred?.type !== "oauth") {
        return { result: null };
      }

      if (Date.now() < cred.expires) {
        return { result: { apiKey: provider.getApiKey(cred), newCredentials: cred } };
      }

      const oauthCreds: Record<string, OAuthCredentials> = {};
      for (const [key, value] of Object.entries(currentData)) {
        if (value.type === "oauth") {
          oauthCreds[key] = value;
        }
      }

      const refreshed = await getOAuthApiKey(providerId, oauthCreds);
      if (!refreshed) {
        return { result: null };
      }

      const merged: AuthStorageData = {
        ...currentData,
        [providerId]: { type: "oauth", ...refreshed.newCredentials },
      };
      this.data = merged;
      this.loadError = null;
      return { result: refreshed, next: JSON.stringify(merged, null, 2) };
    });

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

    const cred = this.data[providerId];

    if (cred?.type === "api_key") {
      return resolveConfigValue(cred.key);
    }

    if (cred?.type === "oauth") {
      const provider = getOAuthProvider(providerId);
      if (!provider) {
        // Unknown OAuth provider, can't get API key
        return undefined;
      }

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
          this.recordError(error);
          // Refresh failed - re-read file to check if another instance succeeded
          this.reload();
          const updatedCred = this.data[providerId];

          if (updatedCred?.type === "oauth" && Date.now() < updatedCred.expires) {
            // Another instance refreshed successfully, use those credentials
            return provider.getApiKey(updatedCred);
          }

          // Refresh truly failed - return undefined so model discovery skips this provider
          // User can /login to re-authenticate (credentials preserved for retry)
          return undefined;
        }
      } else {
        // Token not expired, use current access token
        return provider.getApiKey(cred);
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
   * Get all registered OAuth providers
   */
  getOAuthProviders() {
    return getOAuthProviders();
  }
}
