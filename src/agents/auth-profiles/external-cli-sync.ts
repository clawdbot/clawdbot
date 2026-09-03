/**
 * External CLI OAuth synchronization.
 * Reads the MiniMax CLI credential store, decides whether that credential can
 * safely bootstrap the local auth profile, and returns runtime/persisted overlays.
 */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { readMiniMaxCliCredentialsCached } from "../cli-credentials.js";
import { EXTERNAL_CLI_SYNC_TTL_MS, MINIMAX_CLI_PROFILE_ID, authProfilesLog } from "./constants.js";
import { hasUsableOAuthCredential } from "./credential-state.js";
import { isSafeToCopyOAuthIdentity } from "./oauth-identity.js";
import {
  areOAuthCredentialsEquivalent,
  isSafeToAdoptBootstrapOAuthIdentity,
  shouldBootstrapFromExternalCliCredential,
} from "./oauth-shared.js";
import type { AuthProfileStore, OAuthCredential } from "./types.js";

const MINIMAX_CLI_PROVIDER = "minimax-portal";
// A stored profile or a requested refresh scope may name MiniMax under any of
// these ids; the CLI credential belongs to all of them.
const MINIMAX_CLI_PROVIDER_IDS = [MINIMAX_CLI_PROVIDER, "minimax", "minimax-cli"];

type ExternalCliResolvedProfile = {
  profileId: string;
  credential: OAuthCredential;
  persistence: "runtime-only" | "persisted";
};

type ExternalCliAuthProfileOptions = {
  allowKeychainPrompt?: boolean;
  providerIds?: Iterable<string>;
  profileIds?: Iterable<string>;
};

/** Provider ids whose external CLI credentials can be refreshed by this owner. */
export function listExternalCliSyncProviderIds(): string[] {
  return [...MINIMAX_CLI_PROVIDER_IDS];
}

function readMiniMaxCliCredential(provider: string): OAuthCredential | null {
  const credential = readMiniMaxCliCredentialsCached({ ttlMs: EXTERNAL_CLI_SYNC_TTL_MS });
  return credential ? { ...credential, provider } : null;
}

function isMiniMaxCliOAuthProfile(
  credential: AuthProfileStore["profiles"][string] | undefined,
): credential is OAuthCredential {
  return credential?.type === "oauth" && MINIMAX_CLI_PROVIDER_IDS.includes(credential.provider);
}

function isMiniMaxCliRefreshInScope(params: {
  store: AuthProfileStore;
  options?: ExternalCliAuthProfileOptions;
}): boolean {
  const { options, store } = params;
  // An unscoped refresh only touches a profile the store already holds for this CLI.
  if (options?.providerIds === undefined && options?.profileIds === undefined) {
    return isMiniMaxCliOAuthProfile(store.profiles[MINIMAX_CLI_PROFILE_ID]);
  }
  const requestedProfileIds = Array.from(options?.profileIds ?? []);
  if (requestedProfileIds.some((profileId) => profileId.trim() === MINIMAX_CLI_PROFILE_ID)) {
    return true;
  }
  const providerScope = new Set(
    Array.from(options?.providerIds ?? [])
      .map((value) => normalizeProviderId(value))
      .filter((value) => value.length > 0),
  );
  return MINIMAX_CLI_PROVIDER_IDS.some((alias) => providerScope.has(alias));
}

// External CLI bootstrap must never replace a local profile with another identity.
/** Return true when imported CLI credentials match an existing profile identity. */
function isSafeToUseExternalCliCredential(
  existing: OAuthCredential | undefined,
  imported: OAuthCredential,
): boolean {
  if (!existing) {
    return true;
  }
  if (existing.provider !== imported.provider) {
    return false;
  }
  return isSafeToCopyOAuthIdentity(existing, imported);
}

/** Read a CLI credential only for safe bootstrap of an unusable local profile. */
export function readExternalCliBootstrapCredential(params: {
  store: AuthProfileStore;
  profileId: string;
  credential: OAuthCredential;
  allowKeychainPrompt?: boolean;
}): OAuthCredential | null {
  if (
    params.profileId !== MINIMAX_CLI_PROFILE_ID ||
    !MINIMAX_CLI_PROVIDER_IDS.includes(params.credential.provider)
  ) {
    return null;
  }
  return readMiniMaxCliCredential(params.credential.provider);
}

/** True when a previously resolved built-in CLI profile belongs to this refresh scope. */
export function isExternalCliAuthProfileInScope(params: {
  store: AuthProfileStore;
  profileId: string;
  providerIds?: Iterable<string>;
  profileIds?: Iterable<string>;
}): boolean {
  if (params.profileId !== MINIMAX_CLI_PROFILE_ID) {
    return false;
  }
  const existing = params.store.profiles[params.profileId];
  if (existing?.type === "oauth" && !isMiniMaxCliOAuthProfile(existing)) {
    return false;
  }
  return isMiniMaxCliRefreshInScope({ store: params.store, options: params });
}

function backfillExternalCliIdentity(existingOAuth: OAuthCredential): OAuthCredential | null {
  if (existingOAuth.email) {
    return null;
  }
  const creds = readMiniMaxCliCredential(existingOAuth.provider);
  // Matching token material is the only proof the stored profile IS the CLI
  // login; identity fields are absent on the stored side by definition here.
  const sameLogin =
    creds?.email &&
    (creds.refresh === existingOAuth.refresh || creds.access === existingOAuth.access);
  return sameLogin ? { ...existingOAuth, email: creds.email } : null;
}

/** Resolve scoped external CLI auth profiles available to overlay or persist. */
export function resolveExternalCliAuthProfiles(
  store: AuthProfileStore,
  options?: ExternalCliAuthProfileOptions,
): ExternalCliResolvedProfile[] {
  if (!isMiniMaxCliRefreshInScope({ store, options })) {
    return [];
  }
  const profileId = MINIMAX_CLI_PROFILE_ID;
  const existing = store.profiles[profileId];
  const existingOAuth = isMiniMaxCliOAuthProfile(existing) ? existing : undefined;
  if (existing && !existingOAuth) {
    authProfilesLog.debug("kept explicit local auth over external cli bootstrap", {
      profileId,
      provider: MINIMAX_CLI_PROVIDER,
      localType: existing.type,
      localProvider: existing.provider,
    });
    return [];
  }
  const now = Date.now();
  if (existingOAuth && hasUsableOAuthCredential(existingOAuth, { now })) {
    // Profiles synced before identity capture carry no email; backfill the
    // non-secret metadata once the CLI read proves it is the same login.
    const backfilled = backfillExternalCliIdentity(existingOAuth);
    return backfilled ? [{ profileId, credential: backfilled, persistence: "persisted" }] : [];
  }
  const creds = readMiniMaxCliCredential(existingOAuth?.provider ?? MINIMAX_CLI_PROVIDER);
  if (!creds) {
    return [];
  }
  if (existingOAuth && !isSafeToUseExternalCliCredential(existingOAuth, creds)) {
    authProfilesLog.warn("refused external cli oauth bootstrap: identity mismatch", {
      profileId,
      provider: MINIMAX_CLI_PROVIDER,
    });
    return [];
  }
  if (
    existingOAuth &&
    !isSafeToAdoptBootstrapOAuthIdentity(existingOAuth, creds) &&
    !areOAuthCredentialsEquivalent(existingOAuth, creds)
  ) {
    authProfilesLog.warn(
      "refused external cli oauth bootstrap: identity mismatch or missing binding",
      { profileId, provider: MINIMAX_CLI_PROVIDER },
    );
    return [];
  }
  if (
    !shouldBootstrapFromExternalCliCredential({ existing: existingOAuth, imported: creds, now })
  ) {
    if (existingOAuth) {
      authProfilesLog.debug("kept usable local oauth over external cli bootstrap", {
        profileId,
        provider: MINIMAX_CLI_PROVIDER,
        localExpires: existingOAuth.expires,
        externalExpires: creds.expires,
      });
    }
    return [];
  }
  authProfilesLog.debug(
    "used external cli oauth bootstrap because local oauth was missing or unusable",
    {
      profileId,
      provider: MINIMAX_CLI_PROVIDER,
      localExpires: existingOAuth?.expires,
      externalExpires: creds.expires,
    },
  );
  return [{ profileId, credential: creds, persistence: "persisted" }];
}
