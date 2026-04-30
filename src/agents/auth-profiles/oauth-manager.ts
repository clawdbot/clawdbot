import { formatErrorMessage } from "../../infra/errors.js";
import { withFileLock } from "../../infra/file-lock.js";
import {
  AUTH_STORE_LOCK_OPTIONS,
  OAUTH_REFRESH_CALL_TIMEOUT_MS,
  OAUTH_REFRESH_LOCK_OPTIONS,
  log,
} from "./constants.js";
import { shouldMirrorRefreshedOAuthCredential } from "./oauth-identity.js";
import {
  buildRefreshContentionError,
  isGlobalRefreshLockTimeoutError,
} from "./oauth-refresh-lock-errors.js";
import {
  areOAuthCredentialsEquivalent,
  hasUsableOAuthCredential,
  isSafeToAdoptBootstrapOAuthIdentity,
  isSafeToAdoptMainStoreOAuthIdentity,
  isSafeToOverwriteStoredOAuthIdentity,
  overlayRuntimeExternalOAuthProfiles,
  shouldBootstrapFromExternalCliCredential,
  shouldPersistRuntimeExternalOAuthProfile,
  shouldReplaceStoredOAuthCredential,
  type RuntimeExternalOAuthProfile,
} from "./oauth-shared.js";
import { ensureAuthStoreFile, resolveAuthStorePath, resolveOAuthRefreshLockPath } from "./paths.js";
import {
  ensureAuthProfileStore,
  loadAuthProfileStoreForSecretsRuntime,
  saveAuthProfileStore,
  resolvePersistedAuthProfileOwnerAgentDir,
  updateAuthProfileStoreWithLock,
} from "./store.js";
import type { AuthProfileStore, OAuthCredential, OAuthCredentials } from "./types.js";

export type OAuthManagerAdapter = {
  buildApiKey: (provider: string, credentials: OAuthCredential) => Promise<string>;
  refreshCredential: (credential: OAuthCredential) => Promise<OAuthCredentials | null>;
  readBootstrapCredential: (params: {
    profileId: string;
    credential: OAuthCredential;
  }) => OAuthCredential | null;
  isRefreshTokenReusedError: (error: unknown) => boolean;
};

export type ResolvedOAuthAccess = {
  apiKey: string;
  credential: OAuthCredential;
};

export class OAuthManagerRefreshError extends Error {
  readonly profileId: string;
  readonly provider: string;
  readonly code?: string;
  readonly lockPath?: string;
  readonly #refreshedStore: AuthProfileStore;
  readonly #credential: OAuthCredential;

  constructor(params: {
    credential: OAuthCredential;
    profileId: string;
    refreshedStore: AuthProfileStore;
    cause: unknown;
  }) {
    const structuredCause =
      typeof params.cause === "object" && params.cause !== null
        ? (params.cause as { code?: unknown; lockPath?: unknown; cause?: unknown })
        : undefined;
    const delegatedCause =
      structuredCause?.code === "refresh_contention" && structuredCause.cause
        ? structuredCause.cause
        : params.cause;
    super(
      `OAuth token refresh failed for ${params.credential.provider}: ${formatErrorMessage(params.cause)}`,
      { cause: delegatedCause },
    );
    this.name = "OAuthManagerRefreshError";
    this.#credential = params.credential;
    this.profileId = params.profileId;
    this.provider = params.credential.provider;
    this.#refreshedStore = params.refreshedStore;
    if (structuredCause) {
      this.code = typeof structuredCause.code === "string" ? structuredCause.code : undefined;
      if (typeof structuredCause.lockPath === "string") {
        this.lockPath = structuredCause.lockPath;
      } else if (
        typeof structuredCause.cause === "object" &&
        structuredCause.cause !== null &&
        "lockPath" in structuredCause.cause &&
        typeof structuredCause.cause.lockPath === "string"
      ) {
        this.lockPath = structuredCause.cause.lockPath;
      }
    }
  }

  getRefreshedStore(): AuthProfileStore {
    return this.#refreshedStore;
  }

  getCredential(): OAuthCredential {
    return this.#credential;
  }

  toJSON(): { name: string; message: string; profileId: string; provider: string } {
    return {
      name: this.name,
      message: this.message,
      profileId: this.profileId,
      provider: this.provider,
    };
  }
}

export {
  areOAuthCredentialsEquivalent,
  hasUsableOAuthCredential,
  isSafeToAdoptBootstrapOAuthIdentity,
  isSafeToAdoptMainStoreOAuthIdentity,
  isSafeToOverwriteStoredOAuthIdentity,
  overlayRuntimeExternalOAuthProfiles,
  shouldBootstrapFromExternalCliCredential,
  shouldPersistRuntimeExternalOAuthProfile,
  shouldReplaceStoredOAuthCredential,
};
export type { RuntimeExternalOAuthProfile };

function hasOAuthCredentialChanged(
  previous: Pick<OAuthCredential, "access" | "refresh" | "expires">,
  current: Pick<OAuthCredential, "access" | "refresh" | "expires">,
): boolean {
  return (
    previous.access !== current.access ||
    previous.refresh !== current.refresh ||
    previous.expires !== current.expires
  );
}

async function loadFreshStoredOAuthCredential(params: {
  profileId: string;
  agentDir?: string;
  provider: string;
  previous?: Pick<OAuthCredential, "access" | "refresh" | "expires">;
  requireChange?: boolean;
}): Promise<OAuthCredential | null> {
  const reloadedStore = loadAuthProfileStoreForSecretsRuntime(params.agentDir);
  const reloaded = reloadedStore.profiles[params.profileId];
  if (
    reloaded?.type !== "oauth" ||
    reloaded.provider !== params.provider ||
    !hasUsableOAuthCredential(reloaded)
  ) {
    return null;
  }
  if (
    params.requireChange &&
    params.previous &&
    !hasOAuthCredentialChanged(params.previous, reloaded)
  ) {
    return null;
  }
  return reloaded;
}

export function resolveEffectiveOAuthCredential(params: {
  profileId: string;
  credential: OAuthCredential;
  readBootstrapCredential: OAuthManagerAdapter["readBootstrapCredential"];
}): OAuthCredential {
  const imported = params.readBootstrapCredential({
    profileId: params.profileId,
    credential: params.credential,
  });
  if (!imported) {
    return params.credential;
  }
  if (hasUsableOAuthCredential(params.credential)) {
    log.debug("resolved oauth credential from canonical local store", {
      profileId: params.profileId,
      provider: params.credential.provider,
      localExpires: params.credential.expires,
      externalExpires: imported.expires,
    });
    return params.credential;
  }
  if (!isSafeToAdoptBootstrapOAuthIdentity(params.credential, imported)) {
    log.warn("refused external oauth bootstrap credential: identity mismatch or missing binding", {
      profileId: params.profileId,
      provider: params.credential.provider,
    });
    return params.credential;
  }
  const shouldBootstrap = shouldBootstrapFromExternalCliCredential({
    existing: params.credential,
    imported,
  });
  if (shouldBootstrap) {
    log.debug("resolved oauth credential from external cli bootstrap", {
      profileId: params.profileId,
      provider: imported.provider,
      localExpires: params.credential.expires,
      externalExpires: imported.expires,
    });
    return imported;
  }
  return params.credential;
}

export function createOAuthManager(adapter: OAuthManagerAdapter) {
  function adoptNewerMainOAuthCredential(params: {
    store: AuthProfileStore;
    profileId: string;
    agentDir?: string;
    credential: OAuthCredential;
  }): OAuthCredential | null {
    if (!params.agentDir) {
      return null;
    }
    try {
      const mainStore = ensureAuthProfileStore(undefined);
      const mainCred = mainStore.profiles[params.profileId];
      if (
        mainCred?.type === "oauth" &&
        mainCred.provider === params.credential.provider &&
        hasUsableOAuthCredential(mainCred) &&
        Number.isFinite(mainCred.expires) &&
        (!Number.isFinite(params.credential.expires) ||
          mainCred.expires > params.credential.expires) &&
        isSafeToAdoptMainStoreOAuthIdentity(params.credential, mainCred)
      ) {
        params.store.profiles[params.profileId] = { ...mainCred };
        log.info("adopted newer OAuth credentials from main agent", {
          profileId: params.profileId,
          agentDir: params.agentDir,
          expires: new Date(mainCred.expires).toISOString(),
        });
        return mainCred;
      }
    } catch (err) {
      log.debug("adoptNewerMainOAuthCredential failed", {
        profileId: params.profileId,
        error: formatErrorMessage(err),
      });
    }
    return null;
  }

  const refreshQueues = new Map<string, Promise<unknown>>();

  function refreshQueueKey(provider: string, profileId: string): string {
    return `${provider}\u0000${profileId}`;
  }

  async function withRefreshCallTimeout<T>(
    label: string,
    timeoutMs: number,
    fn: () => Promise<T>,
  ): Promise<T> {
    let timeoutHandle: NodeJS.Timeout | undefined;
    try {
      return await new Promise<T>((resolve, reject) => {
        timeoutHandle = setTimeout(() => {
          reject(new Error(`OAuth refresh call "${label}" exceeded hard timeout (${timeoutMs}ms)`));
        }, timeoutMs);
        fn().then(resolve, reject);
      });
    } finally {
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
    }
  }

  async function mirrorRefreshedCredentialIntoMainStore(params: {
    profileId: string;
    refreshed: OAuthCredential;
  }): Promise<void> {
    try {
      const mainPath = resolveAuthStorePath(undefined);
      ensureAuthStoreFile(mainPath);
      await updateAuthProfileStoreWithLock({
        agentDir: undefined,
        updater: (store) => {
          const existing = store.profiles[params.profileId];
          const decision = shouldMirrorRefreshedOAuthCredential({
            existing,
            refreshed: params.refreshed,
          });
          if (!decision.shouldMirror) {
            if (decision.reason === "identity-mismatch-or-regression") {
              log.warn("refused to mirror OAuth credential: identity mismatch or regression", {
                profileId: params.profileId,
              });
            }
            return false;
          }
          store.profiles[params.profileId] = { ...params.refreshed };
          log.debug("mirrored refreshed OAuth credential to main agent store", {
            profileId: params.profileId,
            expires: Number.isFinite(params.refreshed.expires)
              ? new Date(params.refreshed.expires).toISOString()
              : undefined,
          });
          return true;
        },
      });
    } catch (err) {
      log.debug("mirrorRefreshedCredentialIntoMainStore failed", {
        profileId: params.profileId,
        error: formatErrorMessage(err),
      });
    }
  }

  async function doRefreshOAuthTokenWithLock(params: {
    profileId: string;
    provider: string;
    agentDir?: string;
  }): Promise<ResolvedOAuthAccess | null> {
    const ownerAgentDir = resolvePersistedAuthProfileOwnerAgentDir(params);
    const authPath = resolveAuthStorePath(ownerAgentDir);
    ensureAuthStoreFile(authPath);
    const globalRefreshLockPath = resolveOAuthRefreshLockPath(params.provider, params.profileId);

    try {
      return await withFileLock(globalRefreshLockPath, OAUTH_REFRESH_LOCK_OPTIONS, async () =>
        withFileLock(authPath, AUTH_STORE_LOCK_OPTIONS, async () => {
          const store = loadAuthProfileStoreForSecretsRuntime(ownerAgentDir);
          const cred = store.profiles[params.profileId];
          if (!cred || cred.type !== "oauth") {
            return null;
          }
          let credentialToRefresh = cred;

          if (hasUsableOAuthCredential(cred)) {
            return {
              apiKey: await adapter.buildApiKey(cred.provider, cred),
              credential: cred,
            };
          }

          if (params.agentDir) {
            try {
              const mainStore = loadAuthProfileStoreForSecretsRuntime(undefined);
              const mainCred = mainStore.profiles[params.profileId];
              if (
                mainCred?.type === "oauth" &&
                mainCred.provider === cred.provider &&
                hasUsableOAuthCredential(mainCred) &&
                isSafeToAdoptMainStoreOAuthIdentity(cred, mainCred)
              ) {
                store.profiles[params.profileId] = { ...mainCred };
                log.info("adopted fresh OAuth credential from main store (under refresh lock)", {
                  profileId: params.profileId,
                  agentDir: params.agentDir,
                  expires: new Date(mainCred.expires).toISOString(),
                });
                return {
                  apiKey: await adapter.buildApiKey(mainCred.provider, mainCred),
                  credential: mainCred,
                };
              } else if (
                mainCred?.type === "oauth" &&
                mainCred.provider === cred.provider &&
                hasUsableOAuthCredential(mainCred) &&
                !isSafeToAdoptMainStoreOAuthIdentity(cred, mainCred)
              ) {
                log.warn("refused to adopt fresh main-store OAuth credential: identity mismatch", {
                  profileId: params.profileId,
                  agentDir: params.agentDir,
                });
              }
            } catch (err) {
              log.debug("inside-lock main-store adoption failed; proceeding to refresh", {
                profileId: params.profileId,
                error: formatErrorMessage(err),
              });
            }
          }

          const externallyManaged = adapter.readBootstrapCredential({
            profileId: params.profileId,
            credential: cred,
          });
          if (externallyManaged) {
            if (externallyManaged.provider !== cred.provider) {
              log.warn("refused external oauth bootstrap credential: provider mismatch", {
                profileId: params.profileId,
                provider: cred.provider,
              });
            } else if (!isSafeToAdoptBootstrapOAuthIdentity(cred, externallyManaged)) {
              log.warn(
                "refused external oauth bootstrap credential: identity mismatch or missing binding",
                {
                  profileId: params.profileId,
                  provider: cred.provider,
                },
              );
            } else {
              if (
                shouldReplaceStoredOAuthCredential(cred, externallyManaged) &&
                !areOAuthCredentialsEquivalent(cred, externallyManaged)
              ) {
                store.profiles[params.profileId] = { ...externallyManaged };
                saveAuthProfileStore(store, ownerAgentDir);
              }
              credentialToRefresh = externallyManaged;
              if (hasUsableOAuthCredential(externallyManaged)) {
                return {
                  apiKey: await adapter.buildApiKey(externallyManaged.provider, externallyManaged),
                  credential: externallyManaged,
                };
              }
            }
          }

          const refreshedCredentials = await withRefreshCallTimeout(
            `refreshOAuthCredential(${cred.provider})`,
            OAUTH_REFRESH_CALL_TIMEOUT_MS,
            async () => {
              const refreshed = await adapter.refreshCredential(credentialToRefresh);
              return refreshed
                ? ({
                    ...credentialToRefresh,
                    ...refreshed,
                    type: "oauth",
                  } satisfies OAuthCredential)
                : null;
            },
          );
          if (!refreshedCredentials) {
            return null;
          }
          store.profiles[params.profileId] = refreshedCredentials;
          saveAuthProfileStore(store, ownerAgentDir);
          if (ownerAgentDir) {
            const mainPath = resolveAuthStorePath(undefined);
            if (mainPath !== authPath) {
              await mirrorRefreshedCredentialIntoMainStore({
                profileId: params.profileId,
                refreshed: refreshedCredentials,
              });
            }
          }
          return {
            apiKey: await adapter.buildApiKey(cred.provider, refreshedCredentials),
            credential: refreshedCredentials,
          };
        }),
      );
    } catch (error) {
      if (isGlobalRefreshLockTimeoutError(error, globalRefreshLockPath)) {
        throw buildRefreshContentionError({
          provider: params.provider,
          profileId: params.profileId,
          cause: error,
        });
      }
      throw error;
    }
  }

  async function refreshOAuthTokenWithLock(params: {
    profileId: string;
    provider: string;
    agentDir?: string;
  }): Promise<ResolvedOAuthAccess | null> {
    const key = refreshQueueKey(params.provider, params.profileId);
    const prev = refreshQueues.get(key) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    refreshQueues.set(key, gate);
    try {
      await prev;
      return await doRefreshOAuthTokenWithLock(params);
    } finally {
      release();
      if (refreshQueues.get(key) === gate) {
        refreshQueues.delete(key);
      }
    }
  }

  async function resolveOAuthAccess(params: {
    store: AuthProfileStore;
    profileId: string;
    credential: OAuthCredential;
    agentDir?: string;
  }): Promise<ResolvedOAuthAccess | null> {
    const adoptedCredential =
      adoptNewerMainOAuthCredential({
        store: params.store,
        profileId: params.profileId,
        agentDir: params.agentDir,
        credential: params.credential,
      }) ?? params.credential;
    const effectiveCredential = resolveEffectiveOAuthCredential({
      profileId: params.profileId,
      credential: adoptedCredential,
      readBootstrapCredential: adapter.readBootstrapCredential,
    });

    if (hasUsableOAuthCredential(effectiveCredential)) {
      return {
        apiKey: await adapter.buildApiKey(effectiveCredential.provider, effectiveCredential),
        credential: effectiveCredential,
      };
    }

    try {
      const refreshed = await refreshOAuthTokenWithLock({
        profileId: params.profileId,
        provider: params.credential.provider,
        agentDir: params.agentDir,
      });
      return refreshed;
    } catch (error) {
      const refreshedStore = loadAuthProfileStoreForSecretsRuntime(params.agentDir);
      const refreshed = refreshedStore.profiles[params.profileId];
      if (refreshed?.type === "oauth" && hasUsableOAuthCredential(refreshed)) {
        return {
          apiKey: await adapter.buildApiKey(refreshed.provider, refreshed),
          credential: refreshed,
        };
      }
      if (
        adapter.isRefreshTokenReusedError(error) &&
        refreshed?.type === "oauth" &&
        refreshed.provider === params.credential.provider &&
        hasOAuthCredentialChanged(params.credential, refreshed)
      ) {
        const recovered = await loadFreshStoredOAuthCredential({
          profileId: params.profileId,
          agentDir: params.agentDir,
          provider: params.credential.provider,
          previous: params.credential,
          requireChange: true,
        });
        if (recovered) {
          return {
            apiKey: await adapter.buildApiKey(recovered.provider, recovered),
            credential: recovered,
          };
        }
        try {
          const retried = await refreshOAuthTokenWithLock({
            profileId: params.profileId,
            provider: params.credential.provider,
            agentDir: params.agentDir,
          });
          if (retried) {
            return retried;
          }
        } catch {
          // Retry failed too; keep flowing through the main-store fallback
          // and final wrapped error path below.
        }
      }
      if (params.agentDir) {
        try {
          const mainStore = ensureAuthProfileStore(undefined);
          const mainCred = mainStore.profiles[params.profileId];
          if (
            mainCred?.type === "oauth" &&
            mainCred.provider === params.credential.provider &&
            hasUsableOAuthCredential(mainCred) &&
            isSafeToAdoptMainStoreOAuthIdentity(params.credential, mainCred)
          ) {
            refreshedStore.profiles[params.profileId] = { ...mainCred };
            log.info("inherited fresh OAuth credentials from main agent", {
              profileId: params.profileId,
              agentDir: params.agentDir,
              expires: new Date(mainCred.expires).toISOString(),
            });
            return {
              apiKey: await adapter.buildApiKey(mainCred.provider, mainCred),
              credential: mainCred,
            };
          }
        } catch {
          // keep the original refresh error below
        }
      }
      throw new OAuthManagerRefreshError({
        credential: params.credential,
        profileId: params.profileId,
        refreshedStore,
        cause: error,
      });
    }
  }

  function resetRefreshQueuesForTest(): void {
    refreshQueues.clear();
  }

  return {
    resolveOAuthAccess,
    resetRefreshQueuesForTest,
  };
}
