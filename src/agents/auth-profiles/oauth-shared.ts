/**
 * Shared OAuth credential replacement and identity policy.
 * Used by manager, external CLI overlays, and persistence paths to decide when
 * incoming runtime credentials may replace or bootstrap stored profiles.
 */
import { asDateTimestampMs } from "../../shared/number-coercion.js";
import { cloneAuthProfileStore } from "./clone.js";
import { hasUsableOAuthCredential as hasUsableStoredOAuthCredential } from "./credential-state.js";
import type { AuthProfileStore, OAuthCredential } from "./types.js";

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
    existingExpires !== undefined &&
    (incomingExpires === undefined || existingExpires > incomingExpires),
  );
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
  return !hasNewerStoredOAuthCredential(existing, incoming);
}

/** Returns true when an OAuth credential has a usable access token. */
export function hasUsableOAuthCredential(
  credential: OAuthCredential | undefined,
  now = Date.now(),
): boolean {
  return hasUsableStoredOAuthCredential(credential, { now });
}

/** Normalizes account identity tokens for equality checks. */
export function normalizeAuthIdentityToken(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** Normalizes auth email identity tokens for equality checks. */
export function normalizeAuthEmailToken(value: string | undefined): string | undefined {
  return normalizeAuthIdentityToken(value)?.toLowerCase();
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
  const existingAccountId = normalizeAuthIdentityToken(existing.accountId);
  const incomingAccountId = normalizeAuthIdentityToken(incoming.accountId);
  if (existingAccountId !== undefined && incomingAccountId !== undefined) {
    return existingAccountId === incomingAccountId;
  }

  const existingEmail = normalizeAuthEmailToken(existing.email);
  const incomingEmail = normalizeAuthEmailToken(incoming.email);
  if (existingEmail !== undefined && incomingEmail !== undefined) {
    return existingEmail === incomingEmail;
  }

  return false;
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

/** Returns true when stored OAuth identity can be overwritten. */
export function isSafeToOverwriteStoredOAuthIdentity(
  existing: OAuthCredential | undefined,
  incoming: OAuthCredential,
): boolean {
  return isSafeOAuthIdentityTransition(existing, incoming, {
    whenExistingCredentialMissing: true,
    whenExistingIdentityMissing: false,
  });
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
  if (hasUsableOAuthCredential(params.existing, now)) {
    return false;
  }
  return hasUsableOAuthCredential(params.imported, now);
}

/** Overlays runtime external OAuth profiles on a cloned store. */
export function overlayRuntimeExternalOAuthProfiles(
  store: AuthProfileStore,
  profiles: Iterable<RuntimeExternalOAuthProfile>,
  options?: { runtimeExternalProfileIdsAuthoritative?: boolean },
): AuthProfileStore {
  const externalProfiles = Array.from(profiles);
  const next = cloneAuthProfileStore(store);
  for (const profile of externalProfiles) {
    next.profiles[profile.profileId] = profile.credential;
  }
  const runtimeOnlyProfileIds = new Set(
    externalProfiles
      .filter((profile) => profile.persistence !== "persisted")
      .map((profile) => profile.profileId),
  );
  // Preserve previous runtime-only profile ids that still exist so repeated
  // overlays do not accidentally persist or drop external profile metadata.
  for (const profileId of store.runtimeExternalProfileIds ?? []) {
    if (next.profiles[profileId]) {
      runtimeOnlyProfileIds.add(profileId);
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
