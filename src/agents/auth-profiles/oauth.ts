import {
  getOAuthApiKey,
  getOAuthProviders,
  type OAuthCredentials,
  type OAuthProvider,
} from "@mariozechner/pi-ai/oauth";
import { loadConfig } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { coerceSecretRef } from "../../config/types.secrets.js";
import { formatErrorMessage } from "../../infra/errors.js";
import {
  FILE_LOCK_TIMEOUT_ERROR_CODE,
  type FileLockTimeoutError,
  withFileLock,
} from "../../infra/file-lock.js";
import {
  formatProviderAuthProfileApiKeyWithPlugin,
  refreshProviderOAuthCredentialWithPlugin,
} from "../../plugins/provider-runtime.runtime.js";
import { resolveSecretRefString, type SecretRefResolveCache } from "../../secrets/resolve.js";
import { normalizeLowercaseStringOrEmpty } from "../../shared/string-coerce.js";
import { refreshChutesTokens } from "../chutes-oauth.js";
import {
  AUTH_STORE_LOCK_OPTIONS,
  OAUTH_REFRESH_CALL_TIMEOUT_MS,
  OAUTH_REFRESH_LOCK_OPTIONS,
  log,
} from "./constants.js";
import { resolveTokenExpiryState } from "./credential-state.js";
import { formatAuthDoctorHint } from "./doctor.js";
import { resolveEffectiveOAuthCredential } from "./effective-oauth.js";
import {
  areOAuthCredentialsEquivalent,
  hasUsableOAuthCredential,
  isSafeToUseExternalCliCredential,
  readExternalCliBootstrapCredential,
  shouldReplaceStoredOAuthCredential,
} from "./external-cli-sync.js";
import { ensureAuthStoreFile, resolveAuthStorePath, resolveOAuthRefreshLockPath } from "./paths.js";
import { assertNoOAuthSecretRefPolicyViolations } from "./policy.js";
import { suggestOAuthProfileIdForLegacyDefault } from "./repair.js";
import {
  ensureAuthProfileStore,
  loadAuthProfileStoreForSecretsRuntime,
  saveAuthProfileStore,
  updateAuthProfileStoreWithLock,
} from "./store.js";
import type { AuthProfileStore, OAuthCredential } from "./types.js";

function listOAuthProviderIds(): string[] {
  if (typeof getOAuthProviders !== "function") {
    return [];
  }
  const providers = getOAuthProviders();
  if (!Array.isArray(providers)) {
    return [];
  }
  return providers
    .map((provider) =>
      provider &&
      typeof provider === "object" &&
      "id" in provider &&
      typeof provider.id === "string"
        ? provider.id
        : undefined,
    )
    .filter((providerId): providerId is string => typeof providerId === "string");
}

const OAUTH_PROVIDER_IDS = new Set<string>(listOAuthProviderIds());

const isOAuthProvider = (provider: string): provider is OAuthProvider =>
  OAUTH_PROVIDER_IDS.has(provider);

const resolveOAuthProvider = (provider: string): OAuthProvider | null =>
  isOAuthProvider(provider) ? provider : null;

/** Bearer-token auth modes that are interchangeable (oauth tokens and raw tokens). */
const BEARER_AUTH_MODES = new Set(["oauth", "token"]);

const isCompatibleModeType = (mode: string | undefined, type: string | undefined): boolean => {
  if (!mode || !type) {
    return false;
  }
  if (mode === type) {
    return true;
  }
  // Both token and oauth represent bearer-token auth paths — allow bidirectional compat.
  return BEARER_AUTH_MODES.has(mode) && BEARER_AUTH_MODES.has(type);
};

function isProfileConfigCompatible(params: {
  cfg?: OpenClawConfig;
  profileId: string;
  provider: string;
  mode: "api_key" | "token" | "oauth";
  allowOAuthTokenCompatibility?: boolean;
}): boolean {
  const profileConfig = params.cfg?.auth?.profiles?.[params.profileId];
  if (profileConfig && profileConfig.provider !== params.provider) {
    return false;
  }
  if (profileConfig && !isCompatibleModeType(profileConfig.mode, params.mode)) {
    return false;
  }
  return true;
}

async function buildOAuthApiKey(provider: string, credentials: OAuthCredential): Promise<string> {
  const formatted = await formatProviderAuthProfileApiKeyWithPlugin({
    provider,
    context: credentials,
  });
  return typeof formatted === "string" && formatted.length > 0 ? formatted : credentials.access;
}

function buildApiKeyProfileResult(params: { apiKey: string; provider: string; email?: string }) {
  return {
    apiKey: params.apiKey,
    provider: params.provider,
    email: params.email,
  };
}

async function buildOAuthProfileResult(params: {
  provider: string;
  credentials: OAuthCredential;
  email?: string;
}) {
  return buildApiKeyProfileResult({
    apiKey: await buildOAuthApiKey(params.provider, params.credentials),
    provider: params.provider,
    email: params.email,
  });
}

function extractErrorMessage(error: unknown): string {
  return formatErrorMessage(error);
}

export function isRefreshTokenReusedError(error: unknown): boolean {
  const message = normalizeLowercaseStringOrEmpty(extractErrorMessage(error));
  return (
    message.includes("refresh_token_reused") ||
    message.includes("refresh token has already been used") ||
    message.includes("already been used to generate a new access token")
  );
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

type ResolveApiKeyForProfileParams = {
  cfg?: OpenClawConfig;
  store: AuthProfileStore;
  profileId: string;
  agentDir?: string;
};

type SecretDefaults = NonNullable<OpenClawConfig["secrets"]>["defaults"];

function adoptNewerMainOAuthCredential(params: {
  store: AuthProfileStore;
  profileId: string;
  agentDir?: string;
  cred: OAuthCredentials & { type: "oauth"; provider: string; email?: string };
}): (OAuthCredentials & { type: "oauth"; provider: string; email?: string }) | null {
  if (!params.agentDir) {
    return null;
  }
  try {
    const mainStore = ensureAuthProfileStore(undefined);
    const mainCred = mainStore.profiles[params.profileId];
    if (
      mainCred?.type === "oauth" &&
      mainCred.provider === params.cred.provider &&
      Number.isFinite(mainCred.expires) &&
      (!Number.isFinite(params.cred.expires) || mainCred.expires > params.cred.expires) &&
      // Defense-in-depth against cross-account leaks: refuse on positive
      // mismatch, identity regression, or non-overlapping-field
      // credentials. Tolerates the pure upgrade case where the sub has
      // no identity metadata yet and main does.
      isSafeToCopyOAuthIdentity(params.cred, mainCred)
    ) {
      params.store.profiles[params.profileId] = { ...mainCred };
      saveAuthProfileStore(params.store, params.agentDir);
      log.info("adopted newer OAuth credentials from main agent", {
        profileId: params.profileId,
        agentDir: params.agentDir,
        expires: new Date(mainCred.expires).toISOString(),
      });
      return mainCred;
    }
  } catch (err) {
    // Best-effort: don't crash if main agent store is missing or unreadable.
    log.debug("adoptNewerMainOAuthCredential failed", {
      profileId: params.profileId,
      error: formatErrorMessage(err),
    });
  }
  return null;
}

// In-process serialization: callers for the same provider+profileId are
// chained so only one enters doRefreshOAuthTokenWithLock at a time.
// Necessary because withFileLock is re-entrant within the same PID
// (HELD_LOCKS short-circuits), which would otherwise let two concurrent
// same-PID callers both pass the file lock gate and race to refresh.
//
// The key is `${provider}\0${profileId}` (matching the cross-agent file
// lock key) so two profiles that happen to share a profileId across
// providers do not needlessly serialize against each other.
const refreshQueues = new Map<string, Promise<unknown>>();

function refreshQueueKey(provider: string, profileId: string): string {
  return `${provider}\u0000${profileId}`;
}

/**
 * Wrap an async call with a deadline after which the caller sees a
 * timeout rejection and releases its locks. Used on the OAuth refresh
 * critical section so the in-flight lock cannot outlive
 * OAUTH_REFRESH_LOCK_OPTIONS.stale.
 *
 * LIMITATION: this does NOT cancel the underlying work. JavaScript
 * promises are not cancellable and the pi-ai OAuth stack does not
 * currently accept an AbortSignal. When the deadline fires the caller
 * moves on and releases its file lock, but the original `fn()` promise
 * keeps running in the background. That means a slow upstream refresh
 * could still burn a refresh token well after we have given up on it,
 * and a waiting peer that has now taken the lock may hit
 * `refresh_token_reused`.
 *
 * The existing `isRefreshTokenReusedError` recovery path is the backstop
 * for that residual case — it reloads from the main store and adopts if
 * another agent's refresh has since landed. A fuller fix requires
 * plumbing `AbortSignal` through the refresh stack into the HTTP
 * client; tracked as a follow-up.
 */
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

function createOAuthRefreshContentionError(params: {
  profileId: string;
  provider: string;
  cause?: unknown;
}): Error & { code: "refresh_contention" } {
  const error = new Error(
    `OAuth refresh failed (refresh_contention): another process is already refreshing ${params.provider} for ${params.profileId}`,
    { cause: params.cause },
  );
  return Object.assign(error, { code: "refresh_contention" as const });
}

function isGlobalOAuthRefreshLockTimeoutError(
  error: unknown,
  refreshLockPath: string,
): error is FileLockTimeoutError {
  return (
    (error as { code?: string } | undefined)?.code === FILE_LOCK_TIMEOUT_ERROR_CODE &&
    (error as { lockPath?: string } | undefined)?.lockPath === `${refreshLockPath}.lock`
  );
}

/**
 * Drop any in-flight entries in the module-level refresh queue. Intended
 * exclusively for tests that exercise the concurrent-refresh surface; a
 * timed-out test can leave pending gates in the map and confuse subsequent
 * tests that share the same Vitest worker.
 */
export function resetOAuthRefreshQueuesForTest(): void {
  refreshQueues.clear();
}

async function refreshOAuthTokenWithLock(params: {
  profileId: string;
  provider: string;
  agentDir?: string;
}): Promise<{ apiKey: string; newCredentials: OAuthCredentials } | null> {
  const key = refreshQueueKey(params.provider, params.profileId);
  const prev = refreshQueues.get(key) ?? Promise.resolve();
  let release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
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

/**
 * Mirror a refreshed OAuth credential back into the main-agent store so peer
 * agents adopt it on their next `adoptNewerMainOAuthCredential` pass instead
 * of racing to refresh the (now-single-used) refresh token.
 *
 * Identity binding (CWE-284): we require positive evidence the existing main
 * credential and the refreshed credential belong to the same account before
 * overwriting. If both sides expose `accountId` (strongest signal, Codex CLI)
 * they must match; otherwise if both expose `email` they must match (case-
 * insensitive, trimmed). Provider-only matches are not sufficient because
 * nothing guarantees two agents with the same profileId are authenticated as
 * the same user. This prevents a compromised sub-agent from poisoning the
 * main store's credentials.
 *
 * Serialization: uses `updateAuthProfileStoreWithLock` so the read-modify-
 * write takes the main-store lock and cannot race with other main-store
 * writers (e.g. `updateAuthProfileStoreWithLock` in other flows, CLI-sync).
 *
 * Intentionally best-effort: a failure here must not fail the caller's
 * refresh, since the credential has already been persisted to the agent's
 * own store and returned to the requester.
 */
export function normalizeAuthIdentityToken(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export function normalizeAuthEmailToken(value: string | undefined): string | undefined {
  return normalizeAuthIdentityToken(value)?.toLowerCase();
}

/**
 * Returns true if `existing` and `incoming` provably belong to the same
 * account. Used to gate cross-agent credential mirroring.
 *
 * The rule is intentionally strict to satisfy the CWE-284 model:
 *   1. If one side carries identity metadata (accountId or email) and the
 *      other does not, refuse — we have no evidence they match.
 *   2. If both sides carry identity, a shared field must match (accountId
 *      wins over email when both present). If the two sides carry identity
 *      in non-overlapping fields (one has only accountId, the other only
 *      email), refuse.
 *   3. If neither side carries identity, return true: no evidence of
 *      mismatch and provider equality is checked separately by the caller.
 *
 * The previous permissive behaviour (fall back to `true` whenever a strict
 * comparison could not be made) was unsafe: a sub-agent whose refreshed
 * credential lacked identity metadata could overwrite a known-account main
 * credential that had it, allowing cross-account poisoning through the
 * mirror path.
 */
export function isSameOAuthIdentity(
  existing: Pick<OAuthCredential, "accountId" | "email">,
  incoming: Pick<OAuthCredential, "accountId" | "email">,
): boolean {
  const aAcct = normalizeAuthIdentityToken(existing.accountId);
  const bAcct = normalizeAuthIdentityToken(incoming.accountId);
  const aEmail = normalizeAuthEmailToken(existing.email);
  const bEmail = normalizeAuthEmailToken(incoming.email);
  const aHasIdentity = aAcct !== undefined || aEmail !== undefined;
  const bHasIdentity = bAcct !== undefined || bEmail !== undefined;

  // Asymmetric identity evidence — refuse. We cannot prove the two
  // credentials belong to the same account.
  if (aHasIdentity !== bHasIdentity) {
    return false;
  }

  // Both sides carry identity — require a positive match on a shared field.
  if (aHasIdentity) {
    if (aAcct !== undefined && bAcct !== undefined) {
      return aAcct === bAcct;
    }
    if (aEmail !== undefined && bEmail !== undefined) {
      return aEmail === bEmail;
    }
    // Identity metadata is present on both sides but in non-overlapping
    // fields (one has accountId, the other has only email, or vice versa).
    // No shared field to compare — refuse rather than guess.
    return false;
  }

  // Neither side carries identity metadata — provider equality is checked
  // separately by the caller; no evidence of mismatch here.
  return true;
}

/**
 * Identity gate used for both directions of credential copy:
 *   - mirror (sub-agent refresh -> main agent store)
 *   - adopt (main agent store -> sub-agent store)
 *
 * Rule: allow the copy iff
 *   1. no positive identity mismatch — if both sides expose the same
 *      identity field (accountId or email), the values must match, AND
 *   2. the incoming credential carries at least as much identity
 *      evidence as the existing one — if existing has accountId/email,
 *      incoming must carry the same field, AND
 *   3. when both sides carry identity but in non-overlapping fields
 *      (existing has only accountId, incoming has only email, or vice
 *      versa) we cannot positively prove the same account and the copy
 *      is refused.
 *
 * Accepts:
 *   - matching accountId (positive match on strongest field)
 *   - matching email when accountId is absent on both sides
 *   - neither side carries identity (no evidence of mismatch)
 *   - existing has no identity, incoming has identity (UPGRADE: adds
 *     the marker without dropping anything)
 *
 * Refuses:
 *   - mismatching accountId or email on a shared field (CWE-284 core)
 *   - incoming drops an identity field present on existing (regression
 *     that would later let a wrong-account peer pass this gate)
 *   - non-overlapping fields (no comparable positive match)
 *
 * Design note: this is a single unified rule for both copy directions.
 * The rule is deliberately one-sided because "existing" is whatever is
 * about to be overwritten and "incoming" is the new data — the
 * constraint is the same regardless of whether existing is main or sub.
 */
export function isSafeToCopyOAuthIdentity(
  existing: Pick<OAuthCredential, "accountId" | "email">,
  incoming: Pick<OAuthCredential, "accountId" | "email">,
): boolean {
  const aAcct = normalizeAuthIdentityToken(existing.accountId);
  const bAcct = normalizeAuthIdentityToken(incoming.accountId);
  const aEmail = normalizeAuthEmailToken(existing.email);
  const bEmail = normalizeAuthEmailToken(incoming.email);

  // (1) Positive match on a shared field, if one exists.
  if (aAcct !== undefined && bAcct !== undefined) {
    return aAcct === bAcct;
  }
  if (aEmail !== undefined && bEmail !== undefined) {
    return aEmail === bEmail;
  }

  // No shared comparable field beyond this point.
  const aHasIdentity = aAcct !== undefined || aEmail !== undefined;

  // (2) Refuse if existing has any identity evidence that incoming lacks.
  //     That covers both the "drop" case (incoming has nothing) and the
  //     "non-overlapping fields" case (existing has accountId only,
  //     incoming has email only, or vice versa).
  if (aHasIdentity) {
    return false;
  }

  // (3) Existing has no identity. Either incoming has none either
  //     (allowed: no evidence of mismatch) or incoming adds identity
  //     (allowed: pure upgrade, no loss).
  return true;
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
        if (existing && existing.type !== "oauth") {
          return false;
        }
        if (existing && existing.provider !== params.refreshed.provider) {
          return false;
        }
        // Identity binding for the mirror direction, using the unified
        // copy-safety gate. Accepts upgrades (main has no accountId yet,
        // incoming does) while refusing positive mismatches, identity
        // regressions, and non-overlapping-field credentials.
        if (existing && !isSafeToCopyOAuthIdentity(existing, params.refreshed)) {
          log.warn("refused to mirror OAuth credential: identity mismatch or regression", {
            profileId: params.profileId,
          });
          return false;
        }
        // Only overwrite when the incoming credential is strictly fresher
        // (or main has no usable expiry). Prevents clobbering a concurrent
        // successful refresh performed by the main agent itself.
        if (
          existing &&
          Number.isFinite(existing.expires) &&
          Number.isFinite(params.refreshed.expires) &&
          existing.expires >= params.refreshed.expires
        ) {
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
}): Promise<{ apiKey: string; newCredentials: OAuthCredentials } | null> {
  const authPath = resolveAuthStorePath(params.agentDir);
  ensureAuthStoreFile(authPath);
  // Two-layer coordination:
  //   1. Global refresh lock keyed on sha256(profileId): every agent trying
  //      to refresh the same profile acquires the same file lock, so only
  //      one HTTP refresh is in-flight at a time (#26322).
  //   2. Per-store lock (AUTH_STORE_LOCK_OPTIONS) on this agent's
  //      auth-profiles.json: serializes the refresh's read-modify-writes
  //      with other writers of the same store (e.g. usage/profile updates
  //      via updateAuthProfileStoreWithLock, CLI sync).
  // Lock acquisition order is always refresh -> per-store; non-refresh code
  // paths only take the per-store lock, so no cycle is possible.
  const globalRefreshLockPath = resolveOAuthRefreshLockPath(params.provider, params.profileId);

  try {
    return await withFileLock(globalRefreshLockPath, OAUTH_REFRESH_LOCK_OPTIONS, async () =>
      withFileLock(authPath, AUTH_STORE_LOCK_OPTIONS, async () => {
        // Locked refresh must bypass runtime snapshots so we can adopt fresher
        // on-disk credentials written by another refresh attempt.
        const store = loadAuthProfileStoreForSecretsRuntime(params.agentDir);
        const cred = store.profiles[params.profileId];
        if (!cred || cred.type !== "oauth") {
          return null;
        }

        if (hasUsableOAuthCredential(cred)) {
          return {
            apiKey: await buildOAuthApiKey(cred.provider, cred),
            newCredentials: cred,
          };
        }

        // Inside-the-lock recheck: a prior agent that already held this lock may
        // have completed a refresh and mirrored its fresh credential into the
        // main store. If so, adopt into the local store and return without
        // issuing another HTTP refresh. This is what turns N serialized
        // refreshes into 1 refresh + (N-1) adoptions, preventing the
        // `refresh_token_reused` storm reported in #26322.
        if (params.agentDir) {
          try {
            const mainStore = loadAuthProfileStoreForSecretsRuntime(undefined);
            const mainCred = mainStore.profiles[params.profileId];
            if (
              mainCred?.type === "oauth" &&
              mainCred.provider === cred.provider &&
              hasUsableOAuthCredential(mainCred) &&
              // Defense-in-depth identity gate. Tolerates the pure upgrade
              // case (sub predates identity capture) but refuses positive
              // mismatch, identity regression, and non-overlapping fields.
              isSafeToCopyOAuthIdentity(cred, mainCred)
            ) {
              store.profiles[params.profileId] = { ...mainCred };
              saveAuthProfileStore(store, params.agentDir);
              log.info("adopted fresh OAuth credential from main store (under refresh lock)", {
                profileId: params.profileId,
                agentDir: params.agentDir,
                expires: new Date(mainCred.expires).toISOString(),
              });
              return {
                apiKey: await buildOAuthApiKey(mainCred.provider, mainCred),
                newCredentials: mainCred,
              };
            } else if (
              mainCred?.type === "oauth" &&
              mainCred.provider === cred.provider &&
              hasUsableOAuthCredential(mainCred) &&
              !isSafeToCopyOAuthIdentity(cred, mainCred)
            ) {
              // Main has fresh creds but they belong to a DIFFERENT account —
              // record the refusal so operators can diagnose, then proceed to
              // our own refresh rather than leaking credentials.
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

        const externallyManaged = readExternalCliBootstrapCredential({
          profileId: params.profileId,
          credential: cred,
        });
        let refreshCred = cred;
        if (externallyManaged) {
          if (isSafeToUseExternalCliCredential(cred, externallyManaged)) {
            const hasUsableExternalCredential = hasUsableOAuthCredential(externallyManaged);
            const shouldAdoptExternalCredential =
              shouldReplaceStoredOAuthCredential(cred, externallyManaged) &&
              !areOAuthCredentialsEquivalent(cred, externallyManaged);
            if (shouldAdoptExternalCredential) {
              store.profiles[params.profileId] = externallyManaged;
              saveAuthProfileStore(store, params.agentDir);
              refreshCred = externallyManaged;
            }
            if (hasUsableExternalCredential) {
              return {
                apiKey: await buildOAuthApiKey(externallyManaged.provider, externallyManaged),
                newCredentials: externallyManaged,
              };
            }
          } else {
            log.warn("refused to adopt external cli OAuth credential: identity mismatch", {
              profileId: params.profileId,
              provider: params.provider,
              agentDir: params.agentDir,
            });
          }
        }

        const pluginRefreshed = await withRefreshCallTimeout(
          `refreshProviderOAuthCredentialWithPlugin(${refreshCred.provider})`,
          OAUTH_REFRESH_CALL_TIMEOUT_MS,
          () =>
            refreshProviderOAuthCredentialWithPlugin({
              provider: refreshCred.provider,
              context: refreshCred,
            }),
        );
        if (pluginRefreshed) {
          const refreshedCredentials: OAuthCredential = {
            ...refreshCred,
            ...pluginRefreshed,
            type: "oauth",
          };
          store.profiles[params.profileId] = refreshedCredentials;
          saveAuthProfileStore(store, params.agentDir);
          if (params.agentDir) {
            const mainPath = resolveAuthStorePath(undefined);
            if (mainPath !== authPath) {
              await mirrorRefreshedCredentialIntoMainStore({
                profileId: params.profileId,
                refreshed: refreshedCredentials,
              });
            }
          }
          return {
            apiKey: await buildOAuthApiKey(cred.provider, refreshedCredentials),
            newCredentials: refreshedCredentials,
          };
        }

        const oauthCreds: Record<string, OAuthCredentials> = {
          [refreshCred.provider]: refreshCred,
        };
        const result =
          refreshCred.provider === "chutes"
            ? await (async () => {
                const newCredentials = await withRefreshCallTimeout(
                  `refreshChutesTokens(${refreshCred.provider})`,
                  OAUTH_REFRESH_CALL_TIMEOUT_MS,
                  () => refreshChutesTokens({ credential: refreshCred }),
                );
                return { apiKey: newCredentials.access, newCredentials };
              })()
            : await (async () => {
                const oauthProvider = resolveOAuthProvider(refreshCred.provider);
                if (!oauthProvider) {
                  return null;
                }
                if (typeof getOAuthApiKey !== "function") {
                  return null;
                }
                return await withRefreshCallTimeout(
                  `getOAuthApiKey(${oauthProvider})`,
                  OAUTH_REFRESH_CALL_TIMEOUT_MS,
                  () => getOAuthApiKey(oauthProvider, oauthCreds),
                );
              })();
        if (!result) {
          return null;
        }
        const mergedCred: OAuthCredential = {
          ...refreshCred,
          ...result.newCredentials,
          type: "oauth",
        };
        store.profiles[params.profileId] = mergedCred;
        saveAuthProfileStore(store, params.agentDir);

        // Mirror the refreshed credential back into the main-agent store while
        // both locks are still held (refresh lock + this agent's store lock)
        // plus we'll take main-store lock inside the mirror. Doing this inside
        // the refresh lock closes the cross-process race window where a second
        // agent could acquire the refresh lock between our lock release and
        // our main-store write, see only stale main creds, and redundantly
        // refresh (reproducing refresh_token_reused).
        if (params.agentDir) {
          const mainPath = resolveAuthStorePath(undefined);
          if (mainPath !== authPath) {
            await mirrorRefreshedCredentialIntoMainStore({
              profileId: params.profileId,
              refreshed: mergedCred,
            });
          }
        }

        return result;
      }),
    );
  } catch (error) {
    if (isGlobalOAuthRefreshLockTimeoutError(error, globalRefreshLockPath)) {
      throw createOAuthRefreshContentionError({
        profileId: params.profileId,
        provider: params.provider,
        cause: error,
      });
    }
    throw error;
  }
}

async function tryResolveOAuthProfile(
  params: ResolveApiKeyForProfileParams,
): Promise<{ apiKey: string; provider: string; email?: string } | null> {
  const { cfg, store, profileId } = params;
  const cred = store.profiles[profileId];
  if (!cred || cred.type !== "oauth") {
    return null;
  }
  if (
    !isProfileConfigCompatible({
      cfg,
      profileId,
      provider: cred.provider,
      mode: cred.type,
    })
  ) {
    return null;
  }

  const effectiveCred = resolveEffectiveOAuthCredential({
    profileId,
    credential: cred,
  });

  if (hasUsableOAuthCredential(effectiveCred)) {
    return await buildOAuthProfileResult({
      provider: effectiveCred.provider,
      credentials: effectiveCred,
      email: effectiveCred.email ?? cred.email,
    });
  }

  const refreshed = await refreshOAuthTokenWithLock({
    profileId,
    provider: cred.provider,
    agentDir: params.agentDir,
  });
  if (!refreshed) {
    return null;
  }
  return buildApiKeyProfileResult({
    apiKey: refreshed.apiKey,
    provider: cred.provider,
    email: cred.email,
  });
}

async function resolveProfileSecretString(params: {
  profileId: string;
  provider: string;
  value: string | undefined;
  valueRef: unknown;
  refDefaults: SecretDefaults | undefined;
  configForRefResolution: OpenClawConfig;
  cache: SecretRefResolveCache;
  inlineFailureMessage: string;
  refFailureMessage: string;
}): Promise<string | undefined> {
  let resolvedValue = params.value?.trim();
  if (resolvedValue) {
    const inlineRef = coerceSecretRef(resolvedValue, params.refDefaults);
    if (inlineRef) {
      try {
        resolvedValue = await resolveSecretRefString(inlineRef, {
          config: params.configForRefResolution,
          env: process.env,
          cache: params.cache,
        });
      } catch (err) {
        log.debug(params.inlineFailureMessage, {
          profileId: params.profileId,
          provider: params.provider,
          error: formatErrorMessage(err),
        });
      }
    }
  }

  const explicitRef = coerceSecretRef(params.valueRef, params.refDefaults);
  if (!resolvedValue && explicitRef) {
    try {
      resolvedValue = await resolveSecretRefString(explicitRef, {
        config: params.configForRefResolution,
        env: process.env,
        cache: params.cache,
      });
    } catch (err) {
      log.debug(params.refFailureMessage, {
        profileId: params.profileId,
        provider: params.provider,
        error: formatErrorMessage(err),
      });
    }
  }

  return resolvedValue;
}

export async function resolveApiKeyForProfile(
  params: ResolveApiKeyForProfileParams,
): Promise<{ apiKey: string; provider: string; email?: string } | null> {
  const { cfg, store, profileId } = params;
  const cred = store.profiles[profileId];
  if (!cred) {
    return null;
  }
  if (
    !isProfileConfigCompatible({
      cfg,
      profileId,
      provider: cred.provider,
      mode: cred.type,
      // Compatibility: treat "oauth" config as compatible with stored token profiles.
      allowOAuthTokenCompatibility: true,
    })
  ) {
    return null;
  }

  const refResolveCache: SecretRefResolveCache = {};
  const configForRefResolution = cfg ?? loadConfig();
  const refDefaults = configForRefResolution.secrets?.defaults;
  assertNoOAuthSecretRefPolicyViolations({
    store,
    cfg: configForRefResolution,
    profileIds: [profileId],
    context: `auth profile ${profileId}`,
  });

  if (cred.type === "api_key") {
    const key = await resolveProfileSecretString({
      profileId,
      provider: cred.provider,
      value: cred.key,
      valueRef: cred.keyRef,
      refDefaults,
      configForRefResolution,
      cache: refResolveCache,
      inlineFailureMessage: "failed to resolve inline auth profile api_key ref",
      refFailureMessage: "failed to resolve auth profile api_key ref",
    });
    if (!key) {
      return null;
    }
    return buildApiKeyProfileResult({ apiKey: key, provider: cred.provider, email: cred.email });
  }
  if (cred.type === "token") {
    const expiryState = resolveTokenExpiryState(cred.expires);
    if (expiryState === "expired" || expiryState === "invalid_expires") {
      return null;
    }
    const token = await resolveProfileSecretString({
      profileId,
      provider: cred.provider,
      value: cred.token,
      valueRef: cred.tokenRef,
      refDefaults,
      configForRefResolution,
      cache: refResolveCache,
      inlineFailureMessage: "failed to resolve inline auth profile token ref",
      refFailureMessage: "failed to resolve auth profile token ref",
    });
    if (!token) {
      return null;
    }
    return buildApiKeyProfileResult({ apiKey: token, provider: cred.provider, email: cred.email });
  }

  const oauthCred =
    adoptNewerMainOAuthCredential({
      store,
      profileId,
      agentDir: params.agentDir,
      cred,
    }) ?? cred;
  const effectiveOAuthCred = resolveEffectiveOAuthCredential({
    profileId,
    credential: oauthCred,
  });

  if (hasUsableOAuthCredential(effectiveOAuthCred)) {
    return await buildOAuthProfileResult({
      provider: effectiveOAuthCred.provider,
      credentials: effectiveOAuthCred,
      email: effectiveOAuthCred.email,
    });
  }

  try {
    const result = await refreshOAuthTokenWithLock({
      profileId,
      provider: cred.provider,
      agentDir: params.agentDir,
    });
    if (!result) {
      return null;
    }
    return buildApiKeyProfileResult({
      apiKey: result.apiKey,
      provider: cred.provider,
      email: cred.email,
    });
  } catch (error) {
    const refreshedStore = loadAuthProfileStoreForSecretsRuntime(params.agentDir);
    const refreshed = refreshedStore.profiles[profileId];
    if (refreshed?.type === "oauth" && hasUsableOAuthCredential(refreshed)) {
      return await buildOAuthProfileResult({
        provider: refreshed.provider,
        credentials: refreshed,
        email: refreshed.email ?? cred.email,
      });
    }
    if (
      isRefreshTokenReusedError(error) &&
      refreshed?.type === "oauth" &&
      refreshed.provider === cred.provider &&
      hasOAuthCredentialChanged(cred, refreshed)
    ) {
      const recovered = await loadFreshStoredOAuthCredential({
        profileId,
        agentDir: params.agentDir,
        provider: cred.provider,
        previous: cred,
        requireChange: true,
      });
      if (recovered) {
        return await buildOAuthProfileResult({
          provider: recovered.provider,
          credentials: recovered,
          email: recovered.email ?? cred.email,
        });
      }
      const retried = await refreshOAuthTokenWithLock({
        profileId,
        provider: cred.provider,
        agentDir: params.agentDir,
      });
      if (retried) {
        return buildApiKeyProfileResult({
          apiKey: retried.apiKey,
          provider: cred.provider,
          email: cred.email,
        });
      }
    }
    const fallbackProfileId = suggestOAuthProfileIdForLegacyDefault({
      cfg,
      store: refreshedStore,
      provider: cred.provider,
      legacyProfileId: profileId,
    });
    if (fallbackProfileId && fallbackProfileId !== profileId) {
      try {
        const fallbackResolved = await tryResolveOAuthProfile({
          cfg,
          store: refreshedStore,
          profileId: fallbackProfileId,
          agentDir: params.agentDir,
        });
        if (fallbackResolved) {
          return fallbackResolved;
        }
      } catch {
        // keep original error
      }
    }

    // Fallback: if this is a secondary agent, try using the main agent's credentials
    if (params.agentDir) {
      try {
        const mainStore = ensureAuthProfileStore(undefined); // main agent (no agentDir)
        const mainCred = mainStore.profiles[profileId];
        if (
          mainCred?.type === "oauth" &&
          mainCred.provider === cred.provider &&
          hasUsableOAuthCredential(mainCred) &&
          // Defense-in-depth identity gate — refuse to inherit credentials
          // from a different account even under refresh failure. Tolerates
          // pre-capture credentials but refuses regression/non-overlap.
          isSafeToCopyOAuthIdentity(cred, mainCred)
        ) {
          // Main agent has fresh credentials - copy them to this agent and use them
          refreshedStore.profiles[profileId] = { ...mainCred };
          saveAuthProfileStore(refreshedStore, params.agentDir);
          log.info("inherited fresh OAuth credentials from main agent", {
            profileId,
            agentDir: params.agentDir,
            expires: new Date(mainCred.expires).toISOString(),
          });
          return await buildOAuthProfileResult({
            provider: mainCred.provider,
            credentials: mainCred,
            email: mainCred.email,
          });
        }
      } catch {
        // keep original error if main agent fallback also fails
      }
    }

    const message = extractErrorMessage(error);
    const errorCode = (error as { code?: string } | undefined)?.code;
    const hint = await formatAuthDoctorHint({
      cfg,
      store: refreshedStore,
      provider: cred.provider,
      profileId,
    });
    throw new Error(
      `OAuth token refresh failed for ${cred.provider}: ${message}. ` +
        (errorCode === "refresh_contention"
          ? "Please wait for the in-flight refresh to finish and retry."
          : "Please try again or re-authenticate.") +
        (hint ? `\n\n${hint}` : ""),
      { cause: error },
    );
  }
}
