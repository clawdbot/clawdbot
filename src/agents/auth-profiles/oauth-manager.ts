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
import { isUserModelAuthProfileId } from "../../state/user-model-account-id.js";
import {
  OAUTH_REFRESH_CALL_TIMEOUT_MS,
  OAUTH_REFRESH_LOCK_OPTIONS,
  authProfilesLog,
} from "./constants.js";
import { hasUsableOAuthCredential } from "./credential-state.js";
import { shouldMirrorRefreshedOAuthCredential } from "./oauth-identity.js";
import {
  OAuthRefreshFailureError,
  readProviderOAuthRefreshFailure,
} from "./oauth-refresh-failure.js";
import {
  isExactOAuthCredential,
  observeOAuthRefreshFenceSettlement,
  observeOAuthRefreshSettlement,
} from "./oauth-refresh-fence.js";
import {
  buildRefreshContentionError,
  isGlobalRefreshLockTimeoutError,
} from "./oauth-refresh-lock-errors.js";
import {
  createFailedOAuthRefreshFence,
  createOAuthRefreshFence,
  isOAuthRefreshFence,
  isPendingOAuthRefreshFence,
  isSameOAuthRefreshGeneration,
} from "./oauth-refresh-marker.js";
import {
  hasMatchingOAuthIdentity,
  isSafeToAdoptBootstrapOAuthIdentity,
  isSafeToAdoptMainStoreOAuthIdentity,
  shouldBootstrapFromExternalCliCredential,
} from "./oauth-shared.js";
import { resolveSharedAuthStorePath } from "./path-resolve.js";
import { resolveOAuthRefreshLockPath } from "./paths.js";
import { resolveAuthProfileDatabasePath } from "./sqlite.js";
import {
  ensureAuthProfileStoreWithoutExternalProfiles,
  loadAuthProfileStoreWithoutExternalProfiles,
  updateAuthProfileStoreWithLock,
} from "./store-runtime.js";
import { resolvePersistedAuthProfileOwnerAgentDir } from "./store.js";
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
  canRefreshCredential: (
    credential: OAuthCredential,
    context: { cfg?: OpenClawConfig; agentDir?: string },
  ) => Promise<boolean>;
  readBootstrapCredential: (params: {
    store: AuthProfileStore;
    profileId: string;
    credential: OAuthCredential;
  }) => OAuthCredential | null;
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
    const presentation = readProviderOAuthRefreshFailure(params.cause);
    const causeMessage = formatRedactedOAuthRefreshError(surfacedCause, secrets);
    super({
      provider: params.credential.provider,
      profileId: params.profileId,
      message: `OAuth token refresh failed for ${params.credential.provider}: ${causeMessage}`,
      cause: createRedactedOAuthRefreshCause(surfacedCause, secrets),
      errorType: presentation?.errorType,
      reason: presentation?.reason,
      status: presentation?.status,
      summary: presentation?.summary
        ? formatRedactedOAuthRefreshError(presentation.summary, secrets)
        : undefined,
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
  attempted: OAuthCredential;
  candidate: OAuthCredential;
}): boolean {
  return (
    !params.forceRefresh ||
    (params.attempted.provider === params.candidate.provider &&
      params.attempted.access !== params.candidate.access &&
      hasMatchingOAuthIdentity(params.attempted, params.candidate))
  );
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

function loadStoredOAuthRefreshStore(agentDir?: string, profileId?: string): AuthProfileStore {
  return loadAuthProfileStoreWithoutExternalProfiles(agentDir, {
    allowKeychainPrompt: true,
    profileId,
  });
}

/** Select local OAuth unless a safe external bootstrap credential should win. */
export function resolveEffectiveOAuthCredentialCore(params: {
  store: AuthProfileStore;
  profileId: string;
  credential: OAuthCredential;
  readBootstrapCredential: OAuthManagerAdapter["readBootstrapCredential"];
}): OAuthCredential {
  if (isUserModelAuthProfileId(params.profileId)) {
    return params.credential;
  }
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
    if (!params.agentDir || isUserModelAuthProfileId(params.profileId)) {
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

  type OAuthRefreshClaim =
    | { kind: "unavailable" }
    | {
        kind: "observe";
        ownerAgentDir?: string;
        copiedAgentDir?: string;
        generation: OAuthCredential;
      }
    | { kind: "use"; credential: OAuthCredential }
    | {
        kind: "claimed";
        credential: OAuthCredential;
        fence: OAuthCredential;
        ownerAgentDir?: string;
        copiedAgentDir?: string;
        authPath: string;
      };

  async function settleOAuthRefreshClaim(params: {
    agentDir?: string;
    profileId: string;
    fence: OAuthCredential;
    refreshed: OAuthCredential;
  }): Promise<{ credential: OAuthCredential; persisted: boolean } | null> {
    let credential: OAuthCredential | null = null;
    let persisted = false;
    const result = await updateAuthProfileStoreWithLock({
      agentDir: params.agentDir,
      profileId: params.profileId,
      updater: (store) => {
        const existing = store.profiles[params.profileId];
        if (existing?.type !== "oauth") {
          return false;
        }
        if (isExactOAuthCredential(existing, params.fence)) {
          store.profiles[params.profileId] = { ...params.refreshed };
          credential = params.refreshed;
          persisted = true;
          return true;
        }
        // A reconnect or newer owner generation wins. The stale refresh may use
        // that live credential for this call, but it never overwrites it.
        credential =
          existing.provider === params.refreshed.provider && hasUsableOAuthCredential(existing)
            ? existing
            : null;
        return false;
      },
    });
    return result === null || !credential ? null : { credential, persisted };
  }

  async function markOAuthRefreshClaimFailed(params: {
    agentDir?: string;
    profileId: string;
    fence: OAuthCredential;
  }): Promise<void> {
    try {
      await updateAuthProfileStoreWithLock({
        agentDir: params.agentDir,
        profileId: params.profileId,
        updater: (store) => {
          const existing = store.profiles[params.profileId];
          if (
            !isExactOAuthCredential(existing?.type === "oauth" ? existing : undefined, params.fence)
          ) {
            return false;
          }
          store.profiles[params.profileId] = createFailedOAuthRefreshFence(params.fence);
          return true;
        },
      });
    } catch (error) {
      authProfilesLog.debug("failed to mark OAuth refresh claim terminal", {
        profileId: params.profileId,
        error: formatErrorMessage(error),
      });
    }
  }

  async function fenceCopiedOAuthRefreshGeneration(params: {
    copiedAgentDir?: string;
    profileId: string;
    generation: OAuthCredential;
    fence: OAuthCredential;
  }): Promise<void> {
    if (!params.copiedAgentDir) {
      return;
    }
    const updated = await updateAuthProfileStoreWithLock({
      agentDir: params.copiedAgentDir,
      profileId: params.profileId,
      updater: (store) => {
        const existing = store.profiles[params.profileId];
        if (
          existing?.type !== "oauth" ||
          !isSameOAuthRefreshGeneration({
            profileId: params.profileId,
            left: existing,
            right: params.generation,
          })
        ) {
          return false;
        }
        store.profiles[params.profileId] = { ...params.fence };
        return true;
      },
    });
    if (updated === null) {
      throw new Error("Failed to fence copied OAuth refresh generation");
    }
  }

  async function settleCopiedOAuthRefreshGeneration(params: {
    copiedAgentDir?: string;
    profileId: string;
    generation: OAuthCredential;
    replacement?: OAuthCredential;
  }): Promise<void> {
    if (!params.copiedAgentDir) {
      return;
    }
    const updated = await updateAuthProfileStoreWithLock({
      agentDir: params.copiedAgentDir,
      profileId: params.profileId,
      updater: (store) => {
        const existing = store.profiles[params.profileId];
        if (
          existing?.type !== "oauth" ||
          !isSameOAuthRefreshGeneration({
            profileId: params.profileId,
            left: existing,
            right: params.generation,
          })
        ) {
          return false;
        }
        if (
          params.replacement &&
          hasUsableOAuthCredential(params.replacement) &&
          isSafeToAdoptMainStoreOAuthIdentity(existing, params.replacement)
        ) {
          store.profiles[params.profileId] = { ...params.replacement };
        } else {
          store.profiles[params.profileId] = createFailedOAuthRefreshFence(
            createOAuthRefreshFence({
              profileId: params.profileId,
              credential: existing,
            }),
          );
        }
        return true;
      },
    });
    if (updated === null) {
      throw new Error("Failed to retire copied OAuth refresh generation");
    }
  }

  async function claimOAuthRefresh(params: {
    profileId: string;
    provider: string;
    agentDir?: string;
    cfg?: OpenClawConfig;
    forceRefresh?: boolean;
    attemptedCredential: OAuthCredential;
    bootstrapCredential?: OAuthCredential | null;
    bootstrapBaseCredential?: OAuthCredential;
  }): Promise<OAuthRefreshClaim> {
    const personalProfile = isUserModelAuthProfileId(params.profileId);
    const ownerAgentDir = personalProfile
      ? undefined
      : resolvePersistedAuthProfileOwnerAgentDir(params);
    const copiedAgentDir =
      !personalProfile &&
      !ownerAgentDir &&
      params.agentDir &&
      resolveAuthProfileDatabasePath(params.agentDir) !== resolveSharedAuthStorePath()
        ? params.agentDir
        : undefined;
    const authPath = ownerAgentDir
      ? resolveAuthProfileDatabasePath(ownerAgentDir)
      : resolveSharedAuthStorePath();
    const globalRefreshLockPath = resolveOAuthRefreshLockPath(params.provider, params.profileId);

    try {
      return await withFileLock(globalRefreshLockPath, OAUTH_REFRESH_LOCK_OPTIONS, async () => {
        const store = loadStoredOAuthRefreshStore(ownerAgentDir, params.profileId);
        const cred = store.profiles[params.profileId];
        if (!cred || cred.type !== "oauth") {
          return { kind: "unavailable" };
        }
        const storedFence = isOAuthRefreshFence(cred);
        let credentialToRefresh = cred;

        if (
          params.forceRefresh &&
          hasUsableOAuthCredential(cred) &&
          canReuseOAuthCredentialAfterRefreshFailure({
            forceRefresh: true,
            attempted: params.attemptedCredential,
            candidate: cred,
          })
        ) {
          return { kind: "use", credential: cred };
        }
        if (!storedFence && !params.forceRefresh && hasUsableOAuthCredential(cred)) {
          return { kind: "use", credential: cred };
        }

        if (!storedFence && params.agentDir && !personalProfile) {
          try {
            const mainStore = loadStoredOAuthRefreshStore(undefined);
            const mainCred = mainStore.profiles[params.profileId];
            if (
              ownerAgentDir &&
              mainCred?.type === "oauth" &&
              isSameOAuthRefreshGeneration({
                profileId: params.profileId,
                left: cred,
                right: mainCred,
              })
            ) {
              // The main store owns copied refresh generations. A stale owner
              // resolution must fail closed instead of claiming the local copy.
              return { kind: "unavailable" };
            }
            if (
              mainCred?.type === "oauth" &&
              mainCred.provider === cred.provider &&
              hasUsableOAuthCredential(mainCred) &&
              !params.forceRefresh &&
              isSafeToAdoptMainStoreOAuthIdentity(cred, mainCred)
            ) {
              authProfilesLog.info(
                "adopted fresh OAuth credential from main store (under refresh lock)",
                {
                  profileId: params.profileId,
                  agentDir: params.agentDir,
                  expires: new Date(mainCred.expires).toISOString(),
                },
              );
              return { kind: "use", credential: mainCred };
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

        const externallyManaged =
          !personalProfile &&
          params.bootstrapCredential &&
          params.bootstrapBaseCredential &&
          isExactOAuthCredential(cred, params.bootstrapBaseCredential)
            ? params.bootstrapCredential
            : null;
        if (externallyManaged) {
          if (externallyManaged.provider !== cred.provider) {
            authProfilesLog.warn("refused external oauth bootstrap credential: provider mismatch", {
              profileId: params.profileId,
              provider: cred.provider,
            });
          } else if (storedFence || !isSafeToAdoptBootstrapOAuthIdentity(cred, externallyManaged)) {
            authProfilesLog.warn(
              "refused external oauth bootstrap credential: fenced or identity mismatch",
              {
                profileId: params.profileId,
                provider: cred.provider,
              },
            );
          } else {
            credentialToRefresh = externallyManaged;
            if (!params.forceRefresh && hasUsableOAuthCredential(externallyManaged)) {
              return { kind: "use", credential: externallyManaged };
            }
          }
        }

        if (storedFence && credentialToRefresh === cred) {
          await fenceCopiedOAuthRefreshGeneration({
            copiedAgentDir,
            profileId: params.profileId,
            generation: cred,
            fence: cred,
          });
          return isPendingOAuthRefreshFence(cred)
            ? { kind: "observe", ownerAgentDir, copiedAgentDir, generation: cred }
            : { kind: "unavailable" };
        }
        if (normalizeSecretInputString(credentialToRefresh.refresh) === undefined) {
          return { kind: "unavailable" };
        }
        if (
          !(await adapter.canRefreshCredential(credentialToRefresh, {
            cfg: params.cfg,
            agentDir: params.agentDir,
          }))
        ) {
          return { kind: "unavailable" };
        }

        const fence = createOAuthRefreshFence({
          profileId: params.profileId,
          credential: credentialToRefresh,
        });
        let claimed = false;
        const updated = await updateAuthProfileStoreWithLock({
          agentDir: ownerAgentDir,
          profileId: params.profileId,
          updater: (authoritative) => {
            const existing = authoritative.profiles[params.profileId];
            if (!isExactOAuthCredential(existing?.type === "oauth" ? existing : undefined, cred)) {
              return false;
            }
            authoritative.profiles[params.profileId] = fence;
            claimed = true;
            return true;
          },
        });
        if (updated === null || !claimed) {
          const current = loadStoredOAuthRefreshStore(ownerAgentDir, params.profileId).profiles[
            params.profileId
          ];
          if (current?.type !== "oauth") {
            return { kind: "unavailable" };
          }
          if (isPendingOAuthRefreshFence(current)) {
            await fenceCopiedOAuthRefreshGeneration({
              copiedAgentDir,
              profileId: params.profileId,
              generation: current,
              fence: current,
            });
            return {
              kind: "observe",
              ownerAgentDir,
              copiedAgentDir,
              generation: current,
            };
          }
          if (isOAuthRefreshFence(current)) {
            await fenceCopiedOAuthRefreshGeneration({
              copiedAgentDir,
              profileId: params.profileId,
              generation: current,
              fence: current,
            });
            return { kind: "unavailable" };
          }
          return hasUsableOAuthCredential(current)
            ? { kind: "use", credential: current }
            : { kind: "unavailable" };
        }
        await fenceCopiedOAuthRefreshGeneration({
          copiedAgentDir,
          profileId: params.profileId,
          generation: cred,
          fence,
        });
        return {
          kind: "claimed",
          credential: credentialToRefresh,
          fence,
          ownerAgentDir,
          copiedAgentDir,
          authPath,
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
    profileId: string;
    provider: string;
    agentDir?: string;
    cfg?: OpenClawConfig;
    forceRefresh?: boolean;
    attemptedCredential: OAuthCredential;
    attemptedCredentials?: OAuthCredential[];
    bootstrapCredential?: OAuthCredential | null;
    bootstrapBaseCredential?: OAuthCredential;
  }): Promise<ResolvedOAuthAccess | null> {
    const claim = await claimOAuthRefresh(params);
    if (claim.kind === "unavailable") {
      return null;
    }
    if (claim.kind === "observe") {
      const observed = await observeOAuthRefreshFenceSettlement({
        label: `refreshOAuthCredential(${params.provider})`,
        timeoutMs: OAUTH_REFRESH_CALL_TIMEOUT_MS,
        read: () =>
          loadStoredOAuthRefreshStore(claim.ownerAgentDir, params.profileId).profiles[
            params.profileId
          ],
        isPending: (credential) =>
          credential?.type === "oauth" && isPendingOAuthRefreshFence(credential),
        resolve: async (credential) => {
          if (
            credential?.type !== "oauth" ||
            credential.provider !== params.provider ||
            !hasUsableOAuthCredential(credential)
          ) {
            return null;
          }
          return {
            apiKey: await adapter.buildApiKey(credential.provider, credential, {
              cfg: params.cfg,
              agentDir: params.agentDir,
            }),
            credential,
          };
        },
      });
      await settleCopiedOAuthRefreshGeneration({
        copiedAgentDir: claim.copiedAgentDir,
        profileId: params.profileId,
        generation: claim.generation,
        replacement: observed?.credential,
      });
      return observed;
    }
    if (claim.kind === "use") {
      return {
        apiKey: await adapter.buildApiKey(claim.credential.provider, claim.credential, {
          cfg: params.cfg,
          agentDir: params.agentDir,
        }),
        credential: claim.credential,
      };
    }

    params.attemptedCredentials?.push(claim.credential);
    const settlement = (async (): Promise<ResolvedOAuthAccess | null> => {
      try {
        const refreshed = await adapter.refreshCredential(claim.credential, {
          cfg: params.cfg,
          agentDir: params.agentDir,
        });
        if (!refreshed) {
          await markOAuthRefreshClaimFailed({
            agentDir: claim.ownerAgentDir,
            profileId: params.profileId,
            fence: claim.fence,
          });
          await settleCopiedOAuthRefreshGeneration({
            copiedAgentDir: claim.copiedAgentDir,
            profileId: params.profileId,
            generation: claim.fence,
          });
          return null;
        }
        const rotated = {
          ...claim.credential,
          ...refreshed,
          type: "oauth",
        } satisfies OAuthCredential;
        if (!hasUsableOAuthCredential(rotated)) {
          throw new Error("OAuth refresh returned an unusable credential");
        }
        const settled = await settleOAuthRefreshClaim({
          agentDir: claim.ownerAgentDir,
          profileId: params.profileId,
          fence: claim.fence,
          refreshed: rotated,
        });
        if (!settled) {
          throw new Error("Failed to persist refreshed OAuth credential");
        }
        if (settled.persisted && claim.ownerAgentDir) {
          const mainPath = resolveSharedAuthStorePath();
          if (mainPath !== claim.authPath) {
            await mirrorRefreshedCredentialIntoMainStore({
              profileId: params.profileId,
              refreshed: settled.credential,
            });
          }
        }
        await settleCopiedOAuthRefreshGeneration({
          copiedAgentDir: claim.copiedAgentDir,
          profileId: params.profileId,
          generation: claim.fence,
          replacement: settled.credential,
        });
        return {
          apiKey: await adapter.buildApiKey(settled.credential.provider, settled.credential, {
            cfg: params.cfg,
            agentDir: params.agentDir,
          }),
          credential: settled.credential,
        };
      } catch (error) {
        await markOAuthRefreshClaimFailed({
          agentDir: claim.ownerAgentDir,
          profileId: params.profileId,
          fence: claim.fence,
        });
        await settleCopiedOAuthRefreshGeneration({
          copiedAgentDir: claim.copiedAgentDir,
          profileId: params.profileId,
          generation: claim.fence,
        });
        throw error;
      }
    })();
    // The caller deadline observes the owner; it never cancels durable settlement.
    void settlement.catch(() => {});
    return await observeOAuthRefreshSettlement(
      `refreshOAuthCredential(${claim.credential.provider})`,
      OAUTH_REFRESH_CALL_TIMEOUT_MS,
      settlement,
    );
  }

  async function resolveOAuthAccess(params: {
    store: AuthProfileStore;
    profileId: string;
    credential: OAuthCredential;
    agentDir?: string;
    cfg?: OpenClawConfig;
    forceRefresh?: boolean;
  }): Promise<ResolvedOAuthAccess | null> {
    const personalProfile = isUserModelAuthProfileId(params.profileId);
    let credential = params.credential;
    if (personalProfile) {
      const owned = loadStoredOAuthRefreshStore(params.agentDir, params.profileId).profiles[
        params.profileId
      ];
      if (owned?.type !== "oauth") {
        return null;
      }
      credential = owned;
    }
    const adoptedCredential =
      adoptNewerMainOAuthCredential({
        store: params.store,
        profileId: params.profileId,
        agentDir: params.agentDir,
        credential,
      }) ?? credential;
    const bootstrapCredential = personalProfile
      ? null
      : adapter.readBootstrapCredential({
          store: params.store,
          profileId: params.profileId,
          credential: adoptedCredential,
        });
    const effectiveCredential = resolveEffectiveOAuthCredentialCore({
      store: params.store,
      profileId: params.profileId,
      credential: adoptedCredential,
      readBootstrapCredential: () => bootstrapCredential,
    });
    const attemptedCredentials: OAuthCredential[] = [];

    if (
      !params.forceRefresh &&
      !isOAuthRefreshFence(adoptedCredential) &&
      hasUsableOAuthCredential(effectiveCredential)
    ) {
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
        provider: credential.provider,
        agentDir: params.agentDir,
        cfg: params.cfg,
        forceRefresh: params.forceRefresh,
        attemptedCredential: effectiveCredential,
        attemptedCredentials,
        bootstrapCredential,
        bootstrapBaseCredential: adoptedCredential,
      });
      if (
        refreshed &&
        !personalProfile &&
        params.agentDir &&
        resolveAuthProfileDatabasePath(params.agentDir) !== resolveSharedAuthStorePath()
      ) {
        await settleCopiedOAuthRefreshGeneration({
          copiedAgentDir: params.agentDir,
          profileId: params.profileId,
          generation: effectiveCredential,
          replacement: refreshed.credential,
        });
      }
      return refreshed;
    } catch (error) {
      const refreshedStore = loadStoredOAuthRefreshStore(params.agentDir, params.profileId);
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
      if (params.agentDir && !personalProfile) {
        try {
          const mainStore = ensureAuthProfileStoreWithoutExternalProfiles(undefined, {
            allowKeychainPrompt: false,
          });
          const mainCred = mainStore.profiles[params.profileId];
          if (
            mainCred?.type === "oauth" &&
            mainCred.provider === credential.provider &&
            hasUsableOAuthCredential(mainCred) &&
            canReuseOAuthCredentialAfterRefreshFailure({
              forceRefresh: params.forceRefresh,
              attempted: effectiveCredential,
              candidate: mainCred,
            }) &&
            isSafeToAdoptMainStoreOAuthIdentity(credential, mainCred)
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
        credential,
        attemptedCredentials: [effectiveCredential, ...attemptedCredentials],
        profileId: params.profileId,
        refreshedStore,
        cause: error,
      });
    }
  }

  return {
    resolveOAuthAccess,
  };
}
/* oxlint-disable max-lines -- TODO: split this grandfathered oversized file. */
