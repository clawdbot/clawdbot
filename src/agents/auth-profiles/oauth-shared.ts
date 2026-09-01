/**
 * Shared OAuth credential replacement and identity policy.
 * Used by manager, external CLI overlays, and persistence paths to decide when
 * incoming runtime credentials may replace or bootstrap stored profiles.
 */
import { asDateTimestampMs } from "@openclaw/normalization-core/number-coercion";
import { cloneAuthProfileStore } from "./clone.js";
import { hasUsableOAuthCredential } from "./credential-state.js";
import {
  isSafeToCopyOAuthIdentity,
  normalizeAuthEmailToken,
  normalizeAuthIdentityToken,
} from "./oauth-identity.js";
import type { AuthProfileStore, OAuthCredential, OAuthCredentials } from "./types.js";

export { normalizeAuthEmailToken, normalizeAuthIdentityToken } from "./oauth-identity.js";

/** OAuth profile imported from a runtime external CLI source. */
export type RuntimeExternalOAuthProfile = {
  profileId: string;
  credential: OAuthCredential;
  persistence?: "runtime-only" | "persisted";
};

/** Returns true when two OAuth credentials contain the same token/identity data. */
export function areOAuthCredentialsEquivalent(
  a: OAuthCredential | undefined,
  b: OAuthCredential,
): boolean {
  if (!a || a.type !== "oauth") {
    return false;
  }
  return (
    a.provider === b.provider &&
    a.access === b.access &&
    a.refresh === b.refresh &&
    a.expires === b.expires &&
    a.email === b.email &&
    a.enterpriseUrl === b.enterpriseUrl &&
    a.projectId === b.projectId &&
    a.accountId === b.accountId &&
    a.idToken === b.idToken
  );
}

/** Merge provider-returned OAuth fields after a successful refresh. */
export function mergeSuccessfulOAuthRefreshCredential(
  credential: OAuthCredential,
  refreshed: OAuthCredentials,
): OAuthCredential {
  const merged = {
    ...credential,
    ...refreshed,
    type: "oauth",
  } satisfies OAuthCredential;
  // A successful refresh proves this grant is live. Keeping the tombstone
  // would let external CLI sync replace the healthy credential on reload.
  delete merged.refreshDeadAt;
  return merged;
}

// Keep newer usable stored credentials over incoming runtime imports to avoid
// replacing a fresh access token with stale external CLI state.
function hasNewerStoredOAuthCredential(
  existing: OAuthCredential | undefined,
  incoming: OAuthCredential,
): boolean {
  const existingExpires = asDateTimestampMs(existing?.expires);
  const incomingExpires = asDateTimestampMs(incoming.expires);
  return Boolean(
    existing &&
    existing.provider === incoming.provider &&
    hasUsableOAuthCredential(existing, { now: Date.now() }) &&
    existingExpires !== undefined &&
    (incomingExpires === undefined || existingExpires > incomingExpires),
  );
}

/** Returns true when a stored OAuth credential's refresh grant is known permanently dead. */
export function isOAuthRefreshDead(credential: OAuthCredential | undefined): boolean {
  // Only a finite positive timestamp counts: corrupt/coerced values (0, -1,
  // NaN) must not flag a grant dead and reopen the external re-seed gate.
  const deadAt = credential?.type === "oauth" ? credential.refreshDeadAt : undefined;
  return typeof deadAt === "number" && Number.isFinite(deadAt) && deadAt > 0;
}

/** Returns true when both credentials carry the same non-empty refresh grant. */
export function isSameOAuthRefreshGrant(
  a: OAuthCredential | undefined,
  b: OAuthCredential | undefined,
): boolean {
  if (a?.type !== "oauth" || b?.type !== "oauth" || a.provider !== b.provider) {
    return false;
  }
  const aRefresh = typeof a.refresh === "string" ? a.refresh.trim() : "";
  const bRefresh = typeof b.refresh === "string" ? b.refresh.trim() : "";
  return aRefresh.length > 0 && aRefresh === bRefresh;
}

/** Returns true when an incoming OAuth credential should replace stored state. */
export function shouldReplaceStoredOAuthCredential(
  existing: OAuthCredential | undefined,
  incoming: OAuthCredential,
): boolean {
  if (!existing || existing.type !== "oauth") {
    return true;
  }
  if (areOAuthCredentialsEquivalent(existing, incoming)) {
    return false;
  }
  // A dead refresh grant must never win the "stored is fresher" comparison:
  // its expiry says nothing once the provider rejected the grant for good.
  if (isOAuthRefreshDead(existing) && !isSameOAuthRefreshGrant(existing, incoming)) {
    return true;
  }
  return !hasNewerStoredOAuthCredential(existing, incoming);
}

/** Returns true when an OAuth credential has account or email identity. */
export function hasOAuthIdentity(
  credential: Pick<OAuthCredential, "accountId" | "email">,
): boolean {
  return (
    normalizeAuthIdentityToken(credential.accountId) !== undefined ||
    normalizeAuthEmailToken(credential.email) !== undefined
  );
}

/** Returns true when OAuth identity fields match by account id or email. */
export function hasMatchingOAuthIdentity(
  existing: Pick<OAuthCredential, "accountId" | "email">,
  incoming: Pick<OAuthCredential, "accountId" | "email">,
): boolean {
  return hasOAuthIdentity(existing) && isSafeToCopyOAuthIdentity(existing, incoming);
}

// Different adoption paths have different safety thresholds. Bootstrap can
// adopt missing identities, while stored overwrite requires an identity match.
type OAuthIdentitySafetyPolicy = {
  whenExistingCredentialMissing: boolean;
  whenExistingIdentityMissing: boolean;
};

function isSafeOAuthIdentityTransition(
  existing: OAuthCredential | undefined,
  incoming: OAuthCredential,
  policy: OAuthIdentitySafetyPolicy,
): boolean {
  if (!existing || existing.type !== "oauth") {
    return policy.whenExistingCredentialMissing;
  }
  if (existing.provider !== incoming.provider) {
    return false;
  }
  if (areOAuthCredentialsEquivalent(existing, incoming)) {
    return true;
  }
  if (!hasOAuthIdentity(existing)) {
    return policy.whenExistingIdentityMissing;
  }
  return hasMatchingOAuthIdentity(existing, incoming);
}

/** Returns true when bootstrap may adopt an external OAuth identity. */
export function isSafeToAdoptBootstrapOAuthIdentity(
  existing: OAuthCredential | undefined,
  incoming: OAuthCredential,
): boolean {
  return isSafeOAuthIdentityTransition(existing, incoming, {
    whenExistingCredentialMissing: true,
    whenExistingIdentityMissing: true,
  });
}

/** Returns true when agent-local state may adopt a main-store OAuth identity. */
export function isSafeToAdoptMainStoreOAuthIdentity(
  existing: OAuthCredential | undefined,
  incoming: OAuthCredential,
): boolean {
  return isSafeOAuthIdentityTransition(existing, incoming, {
    whenExistingCredentialMissing: false,
    whenExistingIdentityMissing: true,
  });
}

/** Returns true when an external CLI credential should bootstrap stored OAuth. */
export function shouldBootstrapFromExternalCliCredential(params: {
  existing: OAuthCredential | undefined;
  imported: OAuthCredential;
  now?: number;
}): boolean {
  const now = params.now ?? Date.now();
  if (!hasUsableOAuthCredential(params.imported, { now })) {
    return false;
  }
  if (isOAuthRefreshDead(params.existing)) {
    return !isSameOAuthRefreshGrant(params.existing, params.imported);
  }
  return !hasUsableOAuthCredential(params.existing, { now });
}

/** Overlays runtime external OAuth profiles on a cloned store. */
export function overlayRuntimeExternalOAuthProfiles(
  store: AuthProfileStore,
  profiles: Iterable<RuntimeExternalOAuthProfile>,
  options?: { runtimeExternalProfileIdsAuthoritative?: boolean },
): AuthProfileStore {
  const externalProfiles = Array.from(profiles);
  const next = cloneAuthProfileStore(store);
  const overlaidProfileIds = new Set(externalProfiles.map((profile) => profile.profileId));
  for (const profile of externalProfiles) {
    next.profiles[profile.profileId] = profile.credential;
  }
  next.runtimePersistedProfileIds = store.runtimePersistedProfileIds
    ?.filter((profileId) => next.profiles[profileId] && !overlaidProfileIds.has(profileId))
    .toSorted();
  if (next.runtimePersistedProfileIds?.length === 0) {
    next.runtimePersistedProfileIds = undefined;
  }
  const runtimeOnlyProfileIds = new Set(
    externalProfiles
      .filter((profile) => profile.persistence !== "persisted")
      .map((profile) => profile.profileId),
  );
  if (options?.runtimeExternalProfileIdsAuthoritative !== true) {
    // Scoped overlays are partial. Preserve previous runtime-only profile ids
    // that still exist, except profiles the current overlay explicitly marks
    // persisted. An authoritative overlay is a complete replacement instead.
    for (const profileId of store.runtimeExternalProfileIds ?? []) {
      if (next.profiles[profileId] && !overlaidProfileIds.has(profileId)) {
        runtimeOnlyProfileIds.add(profileId);
      }
    }
  }
  next.runtimeExternalProfileIds =
    runtimeOnlyProfileIds.size > 0 || options?.runtimeExternalProfileIdsAuthoritative === true
      ? [...runtimeOnlyProfileIds].toSorted()
      : undefined;
  next.runtimeExternalProfileIdsAuthoritative =
    options?.runtimeExternalProfileIdsAuthoritative === true ? true : undefined;
  return next;
}

/** Returns true when a runtime external OAuth profile should be persisted. */
export function shouldPersistRuntimeExternalOAuthProfile(params: {
  profileId: string;
  credential: OAuthCredential;
  profiles: Iterable<RuntimeExternalOAuthProfile>;
}): boolean {
  for (const profile of params.profiles) {
    if (profile.profileId !== params.profileId) {
      continue;
    }
    if (profile.persistence === "persisted") {
      return true;
    }
    return !areOAuthCredentialsEquivalent(profile.credential, params.credential);
  }
  return true;
}
