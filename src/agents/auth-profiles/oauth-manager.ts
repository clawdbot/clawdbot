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
import {
  OAUTH_REFRESH_CALL_TIMEOUT_MS,
  OAUTH_REFRESH_LOCK_OPTIONS,
  OAUTH_REFRESH_OWNERSHIP_TIMEOUT_MS,
  authProfilesLog,
} from "./constants.js";
import { hasUsableOAuthCredential } from "./credential-state.js";
import { shouldMirrorRefreshedOAuthCredential } from "./oauth-identity.js";
import { OAuthRefreshFailureError } from "./oauth-refresh-failure.js";
import {
  buildRefreshContentionError,
  isGlobalRefreshLockTimeoutError,
} from "./oauth-refresh-lock-errors.js";
import {
  areOAuthCredentialsEquivalent,
  hasMatchingOAuthIdentity,
  isSafeToAdoptBootstrapOAuthIdentity,
  isSafeToAdoptMainStoreOAuthIdentity,
  shouldBootstrapFromExternalCliCredential,
  shouldReplaceStoredOAuthCredential,
} from "./oauth-shared.js";
import { resolveSharedAuthStorePath } from "./path-resolve.js";
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
  refreshCredential: (
    credential: OAuthCredential,
    context: { cfg?: OpenClawConfig; agentDir?: string },
  ) => Promise<OAuthCredentials | null>;
  readBootstrapCredential: (params: {
    store: AuthProfileStore;
    profileId: string;
    credential: OAuthCredential;
  }) => OAuthCredential | null;
  readAuthoritativeBootstrapCredential?: (params: {
    store: AuthProfileStore;
    profileId: string;
    credential: OAuthCredential;
  }) => OAuthCredential | null;
  isRefreshTokenReusedError: (error: unknown) => boolean;
};

type ResolvedOAuthAccess = {
  apiKey: string;
  credential: OAuthCredential;
};

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

function isSafeExternalOAuthPromotion(
  existing: OAuthCredential,
  incoming: OAuthCredential,
): boolean {
  return (
    existing.provider === incoming.provider &&
    (areOAuthCredentialsEquivalent(existing, incoming) ||
      hasMatchingOAuthIdentity(existing, incoming))
  );
}

function canReuseOAuthCredentialAfterRefreshFailure(params: {
  forceRefresh?: boolean;
  attempted: Pick<OAuthCredential, "access" | "refresh" | "expires">;
  candidate: OAuthCredential;
}): boolean {
  return !params.forceRefresh || hasOAuthCredentialChanged(params.attempted, params.candidate);
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
    !hasOAuthCredentialChanged(params.previous, reloaded)
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

  type OAuthRefreshCallerDeadline = {
    isAbandoned: () => boolean;
    race: <T>(operation: Promise<T>) => Promise<T>;
    withCallerDeadline: <T>(
      label: string,
      timeoutMs: number,
      operation: () => Promise<T>,
    ) => Promise<T>;
  };

  function createOAuthRefreshCallerDeadline(params: {
    label: string;
    timeoutMs: number;
  }): OAuthRefreshCallerDeadline {
    let callerAbandoned = false;
    let rejectCallerDeadline: (error: Error) => void = () => undefined;
    const callerDeadline = new Promise<never>((_resolve, reject) => {
      rejectCallerDeadline = reject;
    });
    const abandonCaller = (label: string, timeoutMs: number) => {
      if (callerAbandoned) {
        return;
      }
      callerAbandoned = true;
      rejectCallerDeadline(
        new Error(`OAuth refresh call "${label}" exceeded hard timeout (${timeoutMs}ms)`),
      );
    };
    const ownershipTimeout = setTimeout(
      () => abandonCaller(params.label, params.timeoutMs),
      params.timeoutMs,
    );
    const withCallerDeadline = async <T>(
      label: string,
      timeoutMs: number,
      operation: () => Promise<T>,
    ): Promise<T> => {
      if (callerAbandoned) {
        throw new Error(`OAuth refresh call "${label}" exceeded caller ownership deadline`);
      }
      let timeoutHandle: NodeJS.Timeout | undefined;
      try {
        timeoutHandle = setTimeout(() => abandonCaller(label, timeoutMs), timeoutMs);
        return await operation();
      } finally {
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
      }
    };
    return {
      isAbandoned: () => callerAbandoned,
      race: async <T>(operation: Promise<T>): Promise<T> => {
        try {
          return await Promise.race([operation, callerDeadline]);
        } finally {
          clearTimeout(ownershipTimeout);
        }
      },
      withCallerDeadline,
    };
  }

  async function withRetainedRefreshLock<T>(
    lockPath: string,
    callerDeadline: OAuthRefreshCallerDeadline,
    fn: (params: {
      withCallerDeadline: <R>(
        label: string,
        timeoutMs: number,
        operation: () => Promise<R>,
      ) => Promise<R>;
    }) => Promise<T>,
  ): Promise<T | null> {
    return await withFileLock(lockPath, OAUTH_REFRESH_LOCK_OPTIONS, async () => {
      if (callerDeadline.isAbandoned()) {
        return null;
      }
      return await fn({
        withCallerDeadline: callerDeadline.withCallerDeadline,
      });
    });
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
    expected: OAuthCredential | OAuthCredential[];
    credential: OAuthCredential;
  }): Promise<boolean> {
    let saved = false;
    const result = await updateAuthProfileStoreWithLock({
      agentDir: params.agentDir,
      updater: (store) => {
        const existing = store.profiles[params.profileId];
        const expectedCredentials = Array.isArray(params.expected)
          ? params.expected
          : [params.expected];
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
        saved = true;
        return true;
      },
    });
    return result !== null && saved;
  }

  async function promoteExternalOAuthCredentialWithStoreLock(params: {
    agentDir?: string;
    profileId: string;
    source: OAuthCredential;
    refreshed: OAuthCredential;
  }): Promise<OAuthCredential | null> {
    let resolved: OAuthCredential | null = null;
    const result = await updateAuthProfileStoreWithLock({
      agentDir: params.agentDir,
      updater: (store) => {
        const existing = store.profiles[params.profileId];
        if (existing) {
          if (
            existing.type === "oauth" &&
            existing.provider === params.refreshed.provider &&
            (areOAuthCredentialsEquivalent(existing, params.source) ||
              hasMatchingOAuthIdentity(existing, params.refreshed))
          ) {
            // Rotation already happened upstream. A same-identity CAS loser
            // must commit the winning token or the token family is bricked.
            store.profiles[params.profileId] = { ...params.refreshed };
            resolved = params.refreshed;
            return true;
          }
          if (
            existing.type === "oauth" &&
            hasUsableOAuthCredential(existing) &&
            existing.provider === params.source.provider
          ) {
            // A different-identity relog won the race. Never overwrite it;
            // adopt only a credential that can satisfy the current request.
            resolved = existing;
          }
          return false;
        }
        if (!isSafeExternalOAuthPromotion(params.source, params.refreshed)) {
          return false;
        }
        if (!hasOAuthCredentialChanged(params.source, params.refreshed)) {
          // A provider may report success without rotating. Return it to the
          // caller, but do not turn unchanged native state into SQLite state.
          resolved = params.refreshed;
          return false;
        }
        store.profiles[params.profileId] = { ...params.refreshed };
        resolved = params.refreshed;
        return true;
      },
    });
    return result === null ? null : resolved;
  }

  async function resolveOAuthCredentialAfterPersistMiss(params: {
    agentDir?: string;
    profileId: string;
    refreshed: OAuthCredential;
  }): Promise<OAuthCredential | null> {
    // Single locked pass decides both outcomes so no relog can slip between a
    // pre-read and the update: same identity persists the rotation, different
    // identity adopts the stored (re-logged) credential for this call.
    let adopted: OAuthCredential | null = null;
    const result = await updateAuthProfileStoreWithLock({
      agentDir: params.agentDir,
      updater: (store) => {
        const existing = store.profiles[params.profileId];
        if (existing?.type !== "oauth" || existing.provider !== params.refreshed.provider) {
          return false;
        }
        // Refresh tokens rotate server-side before persist. Same-identity CAS
        // losers must win the store or the token family is bricked.
        if (hasMatchingOAuthIdentity(existing, params.refreshed)) {
          store.profiles[params.profileId] = { ...params.refreshed };
          adopted = params.refreshed;
          return true;
        }
        adopted = hasUsableOAuthCredential(existing) ? existing : null;
        return false;
      },
    });
    return result === null ? null : adopted;
  }

  async function resolveChangedUsableCredential(params: {
    forceRefresh?: boolean;
    attempted: OAuthCredential;
    candidate: OAuthCredential;
    agentDir?: string;
    cfg?: OpenClawConfig;
  }): Promise<ResolvedOAuthAccess | null> {
    if (
      !params.forceRefresh ||
      params.candidate.provider !== params.attempted.provider ||
      !hasUsableOAuthCredential(params.candidate)
    ) {
      return null;
    }
    const [attemptedApiKey, candidateApiKey] = await Promise.all([
      adapter.buildApiKey(params.attempted.provider, params.attempted, {
        cfg: params.cfg,
        agentDir: params.agentDir,
      }),
      adapter.buildApiKey(params.candidate.provider, params.candidate, {
        cfg: params.cfg,
        agentDir: params.agentDir,
      }),
    ]);
    if (attemptedApiKey === candidateApiKey) {
      return null;
    }
    return { apiKey: candidateApiKey, credential: params.candidate };
  }

  async function doRefreshOAuthTokenWithLock(params: {
    profileId: string;
    provider: string;
    callerCredential: OAuthCredential;
    agentDir?: string;
    cfg?: OpenClawConfig;
    forceRefresh?: boolean;
    attemptedCredentials?: OAuthCredential[];
    externalCliCredential?: OAuthCredential;
    callerDeadline: OAuthRefreshCallerDeadline;
  }): Promise<ResolvedOAuthAccess | null> {
    const ownerAgentDir = resolvePersistedAuthProfileOwnerAgentDir(params);
    const authPath = ownerAgentDir
      ? resolveAuthProfileDatabasePath(ownerAgentDir)
      : resolveSharedAuthStorePath();
    const globalRefreshLockPath = resolveOAuthRefreshLockPath(params.provider, params.profileId);

    try {
      return await withRetainedRefreshLock(
        globalRefreshLockPath,
        params.callerDeadline,
        async ({ withCallerDeadline }) => {
          // A deadline returns control to the caller but retains the file lock
          // until this body settles. The owner completes safe writeback before
          // releasing the rotating token, even after the caller has left.
          const store = loadStoredOAuthRefreshStore(ownerAgentDir);
          const storedCredential = store.profiles[params.profileId];
          if (storedCredential && storedCredential.type !== "oauth") {
            return null;
          }
          const changedStoredCredential = storedCredential
            ? await resolveChangedUsableCredential({
                forceRefresh: params.forceRefresh,
                attempted: params.callerCredential,
                candidate: storedCredential,
                agentDir: params.agentDir,
                cfg: params.cfg,
              })
            : null;
          if (changedStoredCredential) {
            // The caller rejected an older prepared snapshot. Another owner
            // already rotated it, so reuse SQLite instead of rotating again.
            return changedStoredCredential;
          }
          let cred = storedCredential;
          let promotingExternalCliCredential = false;
          if (!cred && params.externalCliCredential) {
            const authoritative = adapter.readAuthoritativeBootstrapCredential?.({
              store,
              profileId: params.profileId,
              credential: params.externalCliCredential,
            });
            if (
              !authoritative ||
              authoritative.provider !== params.externalCliCredential.provider
            ) {
              return null;
            }
            const changedAuthoritativeCredential = await resolveChangedUsableCredential({
              forceRefresh: params.forceRefresh,
              attempted: params.callerCredential,
              candidate: authoritative,
              agentDir: params.agentDir,
              cfg: params.cfg,
            });
            if (changedAuthoritativeCredential) {
              // Native Codex was refreshed or re-logged after this prepared
              // snapshot. Return the reread source without claiming SQLite.
              return changedAuthoritativeCredential;
            }
            if (!isSafeExternalOAuthPromotion(params.externalCliCredential, authoritative)) {
              return null;
            }
            // The fresh CLI read occurs under the global refresh lock. Only
            // this exact native identity may seed SQLite after rotation.
            cred = authoritative;
            promotingExternalCliCredential = true;
          }
          if (!cred) {
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
              authProfilesLog.debug(
                "inside-lock main-store adoption failed; proceeding to refresh",
                {
                  profileId: params.profileId,
                  error: formatErrorMessage(err),
                },
              );
            }
          }

          const externallyManaged = promotingExternalCliCredential
            ? null
            : adapter.readBootstrapCredential({
                store,
                profileId: params.profileId,
                credential: cred,
              });
          if (externallyManaged) {
            if (externallyManaged.provider !== cred.provider) {
              authProfilesLog.warn(
                "refused external oauth bootstrap credential: provider mismatch",
                {
                  profileId: params.profileId,
                  provider: cred.provider,
                },
              );
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
          const refreshedCredentials = await withCallerDeadline(
            `refreshOAuthCredential(${cred.provider})`,
            OAUTH_REFRESH_CALL_TIMEOUT_MS,
            async () => {
              params.attemptedCredentials?.push(credentialToRefresh);
              const refreshed = await adapter.refreshCredential(credentialToRefresh, {
                cfg: params.cfg,
                agentDir: params.agentDir,
              });
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
          if (promotingExternalCliCredential) {
            const promoted = await promoteExternalOAuthCredentialWithStoreLock({
              agentDir: ownerAgentDir,
              profileId: params.profileId,
              source: credentialToRefresh,
              refreshed: refreshedCredentials,
            });
            if (!promoted) {
              return null;
            }
            store.profiles[params.profileId] = promoted;
            return {
              apiKey: await adapter.buildApiKey(promoted.provider, promoted, {
                cfg: params.cfg,
                agentDir: params.agentDir,
              }),
              credential: promoted,
            };
          }
          store.profiles[params.profileId] = refreshedCredentials;
          const persisted = await saveOAuthCredentialWithStoreLock({
            agentDir: ownerAgentDir,
            profileId: params.profileId,
            expected:
              credentialToRefresh === cred ||
              areOAuthCredentialsEquivalent(credentialToRefresh, cred)
                ? credentialToRefresh
                : [credentialToRefresh, cred],
            credential: refreshedCredentials,
          });
          if (!persisted) {
            const recovered = await resolveOAuthCredentialAfterPersistMiss({
              agentDir: ownerAgentDir,
              profileId: params.profileId,
              refreshed: refreshedCredentials,
            });
            if (!recovered) {
              throw new Error("Failed to persist refreshed OAuth credential");
            }
            if (recovered !== refreshedCredentials) {
              return {
                apiKey: await adapter.buildApiKey(recovered.provider, recovered, {
                  cfg: params.cfg,
                  agentDir: params.agentDir,
                }),
                credential: recovered,
              };
            }
          }
          if (ownerAgentDir) {
            const mainPath = resolveSharedAuthStorePath();
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
        },
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
    callerCredential: OAuthCredential;
    agentDir?: string;
    cfg?: OpenClawConfig;
    forceRefresh?: boolean;
    attemptedCredentials?: OAuthCredential[];
    externalCliCredential?: OAuthCredential;
  }): Promise<ResolvedOAuthAccess | null> {
    const key = refreshQueueKey(params.provider, params.profileId);
    const callerDeadline = createOAuthRefreshCallerDeadline({
      label: `${params.provider} oauth refresh ownership`,
      timeoutMs: OAUTH_REFRESH_OWNERSHIP_TIMEOUT_MS,
    });
    const queuedOperation = refreshQueue.enqueue(key, async () => {
      if (callerDeadline.isAbandoned()) {
        return null;
      }
      return await doRefreshOAuthTokenWithLock({ ...params, callerDeadline });
    });
    // The race bounds this caller from queue admission onward. If provider work
    // already began, queuedOperation remains the queue tail until safe writeback.
    return await callerDeadline.race(queuedOperation);
  }

  async function resolveOAuthAccess(params: {
    store: AuthProfileStore;
    profileId: string;
    credential: OAuthCredential;
    agentDir?: string;
    cfg?: OpenClawConfig;
    forceRefresh?: boolean;
    externalCliCredential?: OAuthCredential;
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
        profileId: params.profileId,
        provider: params.credential.provider,
        // This is the bearer actually selected for the failed attempt. Passing
        // the pre-adoption worker credential makes unchanged main state look rotated.
        callerCredential: effectiveCredential,
        agentDir: params.agentDir,
        cfg: params.cfg,
        forceRefresh: params.forceRefresh,
        attemptedCredentials,
        externalCliCredential: params.externalCliCredential,
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
        hasOAuthCredentialChanged(params.credential, refreshed)
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
            profileId: params.profileId,
            provider: params.credential.provider,
            callerCredential: effectiveCredential,
            agentDir: params.agentDir,
            cfg: params.cfg,
            forceRefresh: params.forceRefresh,
            attemptedCredentials,
            externalCliCredential: params.externalCliCredential,
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
