import { asDateTimestampMs } from "@openclaw/normalization-core/number-coercion";
/**
 * OAuth credential manager.
 * Resolves usable access tokens, refreshes expired credentials under global
 * locks, adopts safer main-store credentials, and mirrors refreshed tokens.
 */
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { normalizeSecretInputString } from "../../config/types.secrets.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { withFileLock } from "../../infra/file-lock.js";
import { redactSensitiveText } from "../../logging/redact.js";
import { KeyedAsyncQueue } from "../../plugin-sdk/keyed-async-queue.js";
import { createDeferredCore } from "../../shared/deferred.js";
import {
  OAUTH_REFRESH_CALL_TIMEOUT_MS,
  OAUTH_REFRESH_LOCK_OPTIONS,
  authProfilesLog,
} from "./constants.js";
import { hasOAuthTokenMaterialChanged, hasUsableOAuthCredential } from "./credential-state.js";
import { shouldMirrorRefreshedOAuthCredential } from "./oauth-identity.js";
import {
  OAUTH_REFRESH_CALLER_DEADLINE_MESSAGE,
  OAuthRefreshFailureError,
} from "./oauth-refresh-failure.js";
import {
  buildRefreshContentionError,
  isGlobalRefreshLockTimeoutError,
} from "./oauth-refresh-lock-errors.js";
import {
  areOAuthCredentialsEquivalent,
  isSafeToAdoptBootstrapOAuthIdentity,
  isSafeToAdoptMainStoreOAuthIdentity,
  resolveOAuthRefreshConflict,
  shouldBootstrapFromExternalCliCredential,
  shouldReplaceStoredOAuthCredential,
} from "./oauth-shared.js";
import { resolveOAuthRefreshLockPath } from "./paths.js";
import { resolveAuthProfileDatabasePath } from "./sqlite.js";
import {
  ensureAuthProfileStoreWithoutExternalProfiles,
  loadAuthProfileStoreWithoutExternalProfiles,
  resolvePersistedAuthProfileOwnerAgentDir,
  updateAuthProfileStoreWithLock,
} from "./store.js";
import type { AuthProfileStore, OAuthCredential, OAuthCredentials } from "./types.js";

type OAuthManagerAdapter = {
  buildApiKey: (
    provider: string,
    credentials: OAuthCredential,
    context: { cfg?: OpenClawConfig; agentDir?: string },
  ) => Promise<string>;
  prepareRefresh: (
    credential: OAuthCredential,
    context: { cfg?: OpenClawConfig; agentDir?: string; signal: AbortSignal },
  ) => Promise<PreparedOAuthRefresh>;
  readBootstrapCredential: (params: {
    store: AuthProfileStore;
    profileId: string;
    credential: OAuthCredential;
  }) => OAuthCredential | null;
  isRefreshTokenReusedError: (error: unknown) => boolean;
  refreshTimeoutMs?: number;
};

export type PreparedOAuthRefresh = (
  credential: OAuthCredential,
  signal: AbortSignal,
) => Promise<OAuthCredentials | null>;

type ResolvedOAuthAccess = {
  apiKey: string;
  credential: OAuthCredential;
};

/** Bound one caller while retaining refresh ownership until the operation settles. */
export function runRetainedOAuthRefreshOperation<T>(params: {
  timeoutMs: number;
  run: (signal: AbortSignal) => Promise<T>;
}): Promise<T> {
  const caller = createDeferredCore<T>();
  const controller = new AbortController();
  let timedOut = false;
  const timeoutHandle = setTimeout(() => {
    timedOut = true;
    const error = new Error(`${OAUTH_REFRESH_CALLER_DEADLINE_MESSAGE} (${params.timeoutMs}ms)`);
    controller.abort(error);
    caller.reject(error);
  }, params.timeoutMs);
  let owner: Promise<T>;
  try {
    owner = params.run(controller.signal);
  } catch (error: unknown) {
    owner = Promise.reject(error instanceof Error ? error : new Error(String(error)));
  }
  void owner.then(
    (result) => {
      clearTimeout(timeoutHandle);
      if (!timedOut) {
        caller.resolve(result);
      }
    },
    (error: unknown) => {
      clearTimeout(timeoutHandle);
      if (!timedOut) {
        caller.reject(error instanceof Error ? error : new Error(String(error)));
      }
    },
  );
  return caller.promise;
}

/** Refresh failure that preserves a redacted refreshed store and credential. */
export class OAuthManagerRefreshError extends OAuthRefreshFailureError {
  override readonly profileId: string;
  readonly code?: string;
  readonly lockPath?: string;
  readonly #refreshedStore: AuthProfileStore;
  readonly #credential: OAuthCredential;

  constructor(params: {
    credential: OAuthCredential;
    attemptedCredentials?: OAuthCredential[];
    profileId: string;
    refreshedStore: AuthProfileStore;
    cause: unknown;
  }) {
    const structuredCause =
      typeof params.cause === "object" && params.cause !== null
        ? (params.cause as { code?: unknown; lockPath?: unknown; cause?: unknown })
        : undefined;
    const isRefreshContention = structuredCause?.code === "refresh_contention";
    // Keep the file-lock cause on structured fields only. Flattening it here
    // exposes local lock paths in user-facing auth diagnostics.
    const surfacedCause =
      isRefreshContention && params.cause instanceof Error
        ? new Error(params.cause.message)
        : params.cause;
    const storedCredential = params.refreshedStore.profiles[params.profileId];
    const secrets = collectOAuthCredentialSecrets(
      params.credential,
      ...(params.attemptedCredentials ?? []),
      storedCredential?.type === "oauth" ? storedCredential : undefined,
    );
    const causeMessage = formatRedactedOAuthRefreshError(surfacedCause, secrets);
    super({
      provider: params.credential.provider,
      profileId: params.profileId,
      message: `OAuth token refresh failed for ${params.credential.provider}: ${causeMessage}`,
      cause: createRedactedOAuthRefreshCause(surfacedCause, secrets),
    });
    this.name = "OAuthManagerRefreshError";
    this.#credential = params.credential;
    this.profileId = params.profileId;
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

function canReuseOAuthCredentialAfterRefreshFailure(params: {
  forceRefresh?: boolean;
  attempted: Pick<OAuthCredential, "access" | "refresh" | "expires">;
  candidate: OAuthCredential;
}): boolean {
  return !params.forceRefresh || hasOAuthTokenMaterialChanged(params.attempted, params.candidate);
}

function collectOAuthCredentialSecrets(
  ...credentials: Array<OAuthCredential | undefined>
): string[] {
  const secrets = new Set<string>();
  for (const credential of credentials) {
    for (const secret of [credential?.access, credential?.refresh, credential?.idToken]) {
      if (secret) {
        secrets.add(secret);
      }
    }
  }
  return Array.from(secrets).toSorted((a, b) => b.length - a.length);
}

function redactOAuthCredentialSecrets(message: string, secrets: string[]): string {
  let redacted = message;
  for (const secret of secrets) {
    redacted = redacted.split(secret).join("[redacted]");
  }
  return redacted;
}

function formatRawErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    let formatted = error.message || error.name || "Error";
    let cause: unknown = error.cause;
    const seen = new Set<unknown>([error]);
    while (cause && !seen.has(cause)) {
      seen.add(cause);
      if (cause instanceof Error) {
        if (cause.message) {
          formatted += ` | ${cause.message}`;
        }
        cause = cause.cause;
      } else if (typeof cause === "string") {
        formatted += ` | ${cause}`;
        break;
      } else {
        break;
      }
    }
    return formatted;
  }
  if (
    typeof error === "string" ||
    typeof error === "number" ||
    typeof error === "boolean" ||
    typeof error === "bigint"
  ) {
    return String(error);
  }
  try {
    return JSON.stringify(error) ?? String(error);
  } catch {
    return Object.prototype.toString.call(error);
  }
}

function formatRedactedOAuthRefreshError(error: unknown, secrets: string[]): string {
  return redactSensitiveText(redactOAuthCredentialSecrets(formatRawErrorMessage(error), secrets));
}

function createRedactedOAuthRefreshCause(cause: unknown, secrets: string[]): Error {
  const redacted = formatRedactedOAuthRefreshError(cause, secrets);
  const sanitized = new Error(redacted);
  if (cause instanceof Error && cause.name) {
    sanitized.name = cause.name;
  }
  return sanitized;
}

function loadStoredOAuthRefreshStore(agentDir?: string): AuthProfileStore {
  return loadAuthProfileStoreWithoutExternalProfiles(agentDir, {
    allowKeychainPrompt: true,
  });
}

async function loadFreshStoredOAuthCredential(params: {
  profileId: string;
  agentDir?: string;
  provider: string;
  previous?: Pick<OAuthCredential, "access" | "refresh" | "expires">;
  requireChange?: boolean;
}): Promise<OAuthCredential | null> {
  const reloadedStore = loadStoredOAuthRefreshStore(params.agentDir);
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
    !hasOAuthTokenMaterialChanged(params.previous, reloaded)
  ) {
    return null;
  }
  return reloaded;
}

/** Select local OAuth unless a safe external bootstrap credential should win. */
export function resolveEffectiveOAuthCredentialCore(params: {
  store: AuthProfileStore;
  profileId: string;
  credential: OAuthCredential;
  readBootstrapCredential: OAuthManagerAdapter["readBootstrapCredential"];
}): OAuthCredential {
  const imported = params.readBootstrapCredential({
    store: params.store,
    profileId: params.profileId,
    credential: params.credential,
  });
  if (!imported) {
    return params.credential;
  }
  if (hasUsableOAuthCredential(params.credential)) {
    authProfilesLog.debug("resolved oauth credential from canonical local store", {
      profileId: params.profileId,
      provider: params.credential.provider,
      localExpires: params.credential.expires,
      externalExpires: imported.expires,
    });
    return params.credential;
  }
  if (!isSafeToAdoptBootstrapOAuthIdentity(params.credential, imported)) {
    authProfilesLog.warn(
      "refused external oauth bootstrap credential: identity mismatch or missing binding",
      {
        profileId: params.profileId,
        provider: params.credential.provider,
      },
    );
    return params.credential;
  }
  const shouldBootstrap = shouldBootstrapFromExternalCliCredential({
    existing: params.credential,
    imported,
  });
  if (shouldBootstrap) {
    authProfilesLog.debug("resolved oauth credential from external cli bootstrap", {
      profileId: params.profileId,
      provider: imported.provider,
      localExpires: params.credential.expires,
      externalExpires: imported.expires,
    });
    return imported;
  }
  return params.credential;
}

/** Create an OAuth manager bound to provider-specific build/refresh adapters. */
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
      const mainStore = ensureAuthProfileStoreWithoutExternalProfiles(undefined, {
        allowKeychainPrompt: false,
      });
      const mainCred = mainStore.profiles[params.profileId];
      if (mainCred?.type !== "oauth") {
        return null;
      }
      const mainExpires = asDateTimestampMs(mainCred.expires);
      const localExpires = asDateTimestampMs(params.credential.expires);
      if (
        mainCred.provider === params.credential.provider &&
        hasUsableOAuthCredential(mainCred) &&
        mainExpires !== undefined &&
        (localExpires === undefined || mainExpires > localExpires) &&
        isSafeToAdoptMainStoreOAuthIdentity(params.credential, mainCred)
      ) {
        params.store.profiles[params.profileId] = { ...mainCred };
        authProfilesLog.info("adopted newer OAuth credentials from main agent", {
          profileId: params.profileId,
          agentDir: params.agentDir,
          expires: new Date(mainCred.expires).toISOString(),
        });
        return mainCred;
      }
    } catch (err) {
      authProfilesLog.debug("adoptNewerMainOAuthCredential failed", {
        profileId: params.profileId,
        error: formatErrorMessage(err),
      });
    }
    return null;
  }

  let refreshQueue = new KeyedAsyncQueue();

  function refreshQueueKey(provider: string, profileId: string): string {
    return `${provider}\u0000${profileId}`;
  }

  async function mirrorRefreshedCredentialIntoMainStore(params: {
    profileId: string;
    refreshed: OAuthCredential;
  }): Promise<void> {
    try {
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
              authProfilesLog.warn(
                "refused to mirror OAuth credential: identity mismatch or regression",
                {
                  profileId: params.profileId,
                },
              );
            }
            return false;
          }
          store.profiles[params.profileId] = { ...params.refreshed };
          authProfilesLog.debug("mirrored refreshed OAuth credential to main agent store", {
            profileId: params.profileId,
            expires: Number.isFinite(params.refreshed.expires)
              ? new Date(params.refreshed.expires).toISOString()
              : undefined,
          });
          return true;
        },
      });
    } catch (err) {
      authProfilesLog.debug("mirrorRefreshedCredentialIntoMainStore failed", {
        profileId: params.profileId,
        error: formatErrorMessage(err),
      });
    }
  }

  async function saveOAuthCredentialWithStoreLock(params: {
    agentDir?: string;
    profileId: string;
    expected?: OAuthCredential | OAuthCredential[];
    attempted?: OAuthCredential;
    credential: OAuthCredential;
  }): Promise<OAuthCredential | null> {
    const input = params.attempted ?? params.credential;
    resolveOAuthRefreshConflict({
      authoritative: input,
      attempted: input,
      refreshed: params.credential,
    });
    let selected: OAuthCredential | null = null;
    const result = await updateAuthProfileStoreWithLock({
      agentDir: params.agentDir,
      updater: (store) => {
        const existing = store.profiles[params.profileId];
        if (params.attempted) {
          const decision = resolveOAuthRefreshConflict({
            authoritative: existing,
            attempted: params.attempted,
            refreshed: params.credential,
          });
          selected = decision?.credential ?? null;
          if (!decision?.persist) {
            return false;
          }
          // A refresh token may rotate before persistence. Same-identity CAS
          // losers must persist the rotation or the token family is bricked.
          store.profiles[params.profileId] = { ...decision.credential };
          return true;
        }
        const expectedCredentials = params.expected ? [params.expected].flat() : [];
        if (
          existing?.type !== "oauth" ||
          !expectedCredentials.some((expected) => areOAuthCredentialsEquivalent(existing, expected))
        ) {
          authProfilesLog.debug("skipped OAuth credential write because stored profile changed", {
            profileId: params.profileId,
          });
          return false;
        }
        if (
          !isSafeToAdoptBootstrapOAuthIdentity(existing, params.credential) ||
          !shouldReplaceStoredOAuthCredential(existing, params.credential)
        ) {
          authProfilesLog.debug("skipped OAuth credential write because stored profile changed", {
            profileId: params.profileId,
          });
          return false;
        }
        store.profiles[params.profileId] = { ...params.credential };
        selected = params.credential;
        return true;
      },
    });
    return result === null ? null : selected;
  }

  async function doRefreshOAuthTokenWithLock(params: {
    profileId: string;
    provider: string;
    agentDir?: string;
    cfg?: OpenClawConfig;
    forceRefresh?: boolean;
    attemptedCredentials?: OAuthCredential[];
    refreshCredential: PreparedOAuthRefresh;
    signal: AbortSignal;
  }): Promise<ResolvedOAuthAccess | null> {
    const ownerAgentDir = resolvePersistedAuthProfileOwnerAgentDir(params);
    const authPath = resolveAuthProfileDatabasePath(ownerAgentDir);
    const globalRefreshLockPath = resolveOAuthRefreshLockPath(params.provider, params.profileId);

    try {
      return await withFileLock(globalRefreshLockPath, OAUTH_REFRESH_LOCK_OPTIONS, async () => {
        params.signal.throwIfAborted();
        const store = loadStoredOAuthRefreshStore(ownerAgentDir);
        const cred = store.profiles[params.profileId];
        if (!cred || cred.type !== "oauth") {
          return null;
        }
        let credentialToRefresh = cred;

        if (!params.forceRefresh && hasUsableOAuthCredential(cred)) {
          return {
            apiKey: await adapter.buildApiKey(cred.provider, cred, {
              cfg: params.cfg,
              agentDir: params.agentDir,
            }),
            credential: cred,
          };
        }

        if (params.agentDir) {
          try {
            const mainStore = loadStoredOAuthRefreshStore(undefined);
            const mainCred = mainStore.profiles[params.profileId];
            if (
              mainCred?.type === "oauth" &&
              mainCred.provider === cred.provider &&
              hasUsableOAuthCredential(mainCred) &&
              !params.forceRefresh &&
              isSafeToAdoptMainStoreOAuthIdentity(cred, mainCred)
            ) {
              store.profiles[params.profileId] = { ...mainCred };
              authProfilesLog.info(
                "adopted fresh OAuth credential from main store (under refresh lock)",
                {
                  profileId: params.profileId,
                  agentDir: params.agentDir,
                  expires: new Date(mainCred.expires).toISOString(),
                },
              );
              return {
                apiKey: await adapter.buildApiKey(mainCred.provider, mainCred, {
                  cfg: params.cfg,
                  agentDir: params.agentDir,
                }),
                credential: mainCred,
              };
            } else if (
              mainCred?.type === "oauth" &&
              mainCred.provider === cred.provider &&
              hasUsableOAuthCredential(mainCred) &&
              !isSafeToAdoptMainStoreOAuthIdentity(cred, mainCred)
            ) {
              authProfilesLog.warn(
                "refused to adopt fresh main-store OAuth credential: identity mismatch",
                {
                  profileId: params.profileId,
                  agentDir: params.agentDir,
                },
              );
            }
          } catch (err) {
            authProfilesLog.debug("inside-lock main-store adoption failed; proceeding to refresh", {
              profileId: params.profileId,
              error: formatErrorMessage(err),
            });
          }
        }

        const externallyManaged = adapter.readBootstrapCredential({
          store,
          profileId: params.profileId,
          credential: cred,
        });
        if (externallyManaged) {
          if (externallyManaged.provider !== cred.provider) {
            authProfilesLog.warn("refused external oauth bootstrap credential: provider mismatch", {
              profileId: params.profileId,
              provider: cred.provider,
            });
          } else if (!isSafeToAdoptBootstrapOAuthIdentity(cred, externallyManaged)) {
            authProfilesLog.warn(
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
              await saveOAuthCredentialWithStoreLock({
                agentDir: ownerAgentDir,
                profileId: params.profileId,
                expected: cred,
                credential: externallyManaged,
              });
            }
            credentialToRefresh = externallyManaged;
            if (!params.forceRefresh && hasUsableOAuthCredential(externallyManaged)) {
              return {
                apiKey: await adapter.buildApiKey(externallyManaged.provider, externallyManaged, {
                  cfg: params.cfg,
                  agentDir: params.agentDir,
                }),
                credential: externallyManaged,
              };
            }
          }
        }

        if (normalizeSecretInputString(credentialToRefresh.refresh) === undefined) {
          return null;
        }
        params.attemptedCredentials?.push(credentialToRefresh);
        const refreshed = await params.refreshCredential(credentialToRefresh, params.signal);
        const refreshedCredentials = refreshed
          ? ({
              ...credentialToRefresh,
              ...refreshed,
              type: "oauth",
            } satisfies OAuthCredential)
          : null;
        if (!refreshedCredentials) {
          return null;
        }
        store.profiles[params.profileId] = refreshedCredentials;
        const persisted = await saveOAuthCredentialWithStoreLock({
          agentDir: ownerAgentDir,
          profileId: params.profileId,
          attempted: credentialToRefresh,
          credential: refreshedCredentials,
        });
        if (!persisted) {
          throw new Error("Failed to persist refreshed OAuth credential");
        }
        if (persisted !== refreshedCredentials) {
          return {
            apiKey: await adapter.buildApiKey(persisted.provider, persisted, {
              cfg: params.cfg,
              agentDir: params.agentDir,
            }),
            credential: persisted,
          };
        }
        if (ownerAgentDir) {
          const mainPath = resolveAuthProfileDatabasePath(undefined);
          if (mainPath !== authPath) {
            await mirrorRefreshedCredentialIntoMainStore({
              profileId: params.profileId,
              refreshed: refreshedCredentials,
            });
          }
        }
        return {
          apiKey: await adapter.buildApiKey(cred.provider, refreshedCredentials, {
            cfg: params.cfg,
            agentDir: params.agentDir,
          }),
          credential: refreshedCredentials,
        };
      });
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
    credential: OAuthCredential;
    profileId: string;
    provider: string;
    agentDir?: string;
    cfg?: OpenClawConfig;
    forceRefresh?: boolean;
    attemptedCredentials?: OAuthCredential[];
  }): Promise<ResolvedOAuthAccess | null> {
    const key = refreshQueueKey(params.provider, params.profileId);
    return runRetainedOAuthRefreshOperation({
      timeoutMs: adapter.refreshTimeoutMs ?? OAUTH_REFRESH_CALL_TIMEOUT_MS,
      run: async (signal) => {
        signal.throwIfAborted();
        const refreshCredential = await adapter.prepareRefresh(params.credential, {
          cfg: params.cfg,
          agentDir: params.agentDir,
          signal,
        });
        signal.throwIfAborted();
        return await refreshQueue.enqueue(key, async () => {
          signal.throwIfAborted();
          return await doRefreshOAuthTokenWithLock({
            ...params,
            refreshCredential,
            signal,
          });
        });
      },
    });
  }

  async function resolveOAuthAccess(params: {
    store: AuthProfileStore;
    profileId: string;
    credential: OAuthCredential;
    agentDir?: string;
    cfg?: OpenClawConfig;
    forceRefresh?: boolean;
  }): Promise<ResolvedOAuthAccess | null> {
    const adoptedCredential =
      adoptNewerMainOAuthCredential({
        store: params.store,
        profileId: params.profileId,
        agentDir: params.agentDir,
        credential: params.credential,
      }) ?? params.credential;
    const effectiveCredential = resolveEffectiveOAuthCredentialCore({
      store: params.store,
      profileId: params.profileId,
      credential: adoptedCredential,
      readBootstrapCredential: adapter.readBootstrapCredential,
    });
    const attemptedCredentials: OAuthCredential[] = [];

    if (!params.forceRefresh && hasUsableOAuthCredential(effectiveCredential)) {
      return {
        apiKey: await adapter.buildApiKey(effectiveCredential.provider, effectiveCredential, {
          cfg: params.cfg,
          agentDir: params.agentDir,
        }),
        credential: effectiveCredential,
      };
    }

    try {
      const refreshed = await refreshOAuthTokenWithLock({
        credential: effectiveCredential,
        profileId: params.profileId,
        provider: params.credential.provider,
        agentDir: params.agentDir,
        cfg: params.cfg,
        forceRefresh: params.forceRefresh,
        attemptedCredentials,
      });
      return refreshed;
    } catch (error) {
      const refreshedStore = loadStoredOAuthRefreshStore(params.agentDir);
      const refreshed = refreshedStore.profiles[params.profileId];
      if (
        refreshed?.type === "oauth" &&
        hasUsableOAuthCredential(refreshed) &&
        canReuseOAuthCredentialAfterRefreshFailure({
          forceRefresh: params.forceRefresh,
          attempted: effectiveCredential,
          candidate: refreshed,
        })
      ) {
        return {
          apiKey: await adapter.buildApiKey(refreshed.provider, refreshed, {
            cfg: params.cfg,
            agentDir: params.agentDir,
          }),
          credential: refreshed,
        };
      }
      if (
        adapter.isRefreshTokenReusedError(error) &&
        refreshed?.type === "oauth" &&
        refreshed.provider === params.credential.provider &&
        hasOAuthTokenMaterialChanged(params.credential, refreshed)
      ) {
        const recovered = await loadFreshStoredOAuthCredential({
          profileId: params.profileId,
          agentDir: params.agentDir,
          provider: params.credential.provider,
          previous: effectiveCredential,
          requireChange: true,
        });
        if (recovered) {
          return {
            apiKey: await adapter.buildApiKey(recovered.provider, recovered, {
              cfg: params.cfg,
              agentDir: params.agentDir,
            }),
            credential: recovered,
          };
        }
        try {
          const retried = await refreshOAuthTokenWithLock({
            credential: effectiveCredential,
            profileId: params.profileId,
            provider: params.credential.provider,
            agentDir: params.agentDir,
            cfg: params.cfg,
            forceRefresh: params.forceRefresh,
            attemptedCredentials,
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
          const mainStore = ensureAuthProfileStoreWithoutExternalProfiles(undefined, {
            allowKeychainPrompt: false,
          });
          const mainCred = mainStore.profiles[params.profileId];
          if (
            mainCred?.type === "oauth" &&
            mainCred.provider === params.credential.provider &&
            hasUsableOAuthCredential(mainCred) &&
            canReuseOAuthCredentialAfterRefreshFailure({
              forceRefresh: params.forceRefresh,
              attempted: effectiveCredential,
              candidate: mainCred,
            }) &&
            isSafeToAdoptMainStoreOAuthIdentity(params.credential, mainCred)
          ) {
            refreshedStore.profiles[params.profileId] = { ...mainCred };
            authProfilesLog.info("inherited fresh OAuth credentials from main agent", {
              profileId: params.profileId,
              agentDir: params.agentDir,
              expires: new Date(mainCred.expires).toISOString(),
            });
            return {
              apiKey: await adapter.buildApiKey(mainCred.provider, mainCred, {
                cfg: params.cfg,
                agentDir: params.agentDir,
              }),
              credential: mainCred,
            };
          }
        } catch {
          // keep the original refresh error below
        }
      }
      throw new OAuthManagerRefreshError({
        credential: params.credential,
        attemptedCredentials: [effectiveCredential, ...attemptedCredentials],
        profileId: params.profileId,
        refreshedStore,
        cause: error,
      });
    }
  }

  function resetRefreshQueuesForTest(): void {
    refreshQueue = new KeyedAsyncQueue();
  }

  return {
    resolveOAuthAccess,
    resetRefreshQueuesForTest,
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
