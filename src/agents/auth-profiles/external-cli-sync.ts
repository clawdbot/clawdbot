import {
  readCodexCliCredentialsCached,
  readMiniMaxCliCredentialsCached,
} from "../cli-credentials.js";
import {
  EXTERNAL_CLI_SYNC_TTL_MS,
  MINIMAX_CLI_PROFILE_ID,
  OPENAI_CODEX_DEFAULT_PROFILE_ID,
} from "./constants.js";
import { log } from "./constants.js";
import { hasUsableOAuthCredential as hasUsableOAuthCredentialShared } from "./credential-state.js";
import type { AuthProfileStore, OAuthCredential } from "./types.js";

export type ExternalCliResolvedProfile = {
  profileId: string;
  credential: OAuthCredential;
};

type ExternalCliSyncProvider = {
  profileId: string;
  provider: string;
  readCredentials: () => OAuthCredential | null;
};

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
    a.accountId === b.accountId
  );
}

function normalizeAuthIdentityToken(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function normalizeAuthEmailToken(value: string | undefined): string | undefined {
  return normalizeAuthIdentityToken(value)?.toLowerCase();
}

// Keep this gate aligned with the canonical identity-copy rule in oauth.ts.
export function isSafeToUseExternalCliCredential(
  existing: OAuthCredential | undefined,
  imported: OAuthCredential,
): boolean {
  if (!existing) {
    return true;
  }
  if (existing.provider !== imported.provider) {
    return false;
  }

  const existingAccountId = normalizeAuthIdentityToken(existing.accountId);
  const importedAccountId = normalizeAuthIdentityToken(imported.accountId);
  const existingEmail = normalizeAuthEmailToken(existing.email);
  const importedEmail = normalizeAuthEmailToken(imported.email);

  if (existingAccountId !== undefined && importedAccountId !== undefined) {
    return existingAccountId === importedAccountId;
  }
  if (existingEmail !== undefined && importedEmail !== undefined) {
    return existingEmail === importedEmail;
  }

  const existingHasIdentity = existingAccountId !== undefined || existingEmail !== undefined;
  if (existingHasIdentity) {
    return false;
  }
  return true;
}

function hasNewerStoredOAuthCredential(
  existing: OAuthCredential | undefined,
  incoming: OAuthCredential,
): boolean {
  return Boolean(
    existing &&
    existing.provider === incoming.provider &&
    Number.isFinite(existing.expires) &&
    (!Number.isFinite(incoming.expires) || existing.expires > incoming.expires),
  );
}

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

export function hasUsableOAuthCredential(
  credential: OAuthCredential | undefined,
  now = Date.now(),
): boolean {
  return hasUsableOAuthCredentialShared(credential, { now });
}

export function shouldBootstrapFromExternalCliCredential(params: {
  existing: OAuthCredential | undefined;
  imported: OAuthCredential;
  now?: number;
}): boolean {
  const now = params.now ?? Date.now();
  if (!isSafeToUseExternalCliCredential(params.existing, params.imported)) {
    return false;
  }
  if (hasUsableOAuthCredential(params.existing, now)) {
    return false;
  }
  return hasUsableOAuthCredential(params.imported, now);
}

const EXTERNAL_CLI_SYNC_PROVIDERS: ExternalCliSyncProvider[] = [
  {
    profileId: MINIMAX_CLI_PROFILE_ID,
    provider: "minimax-portal",
    readCredentials: () => readMiniMaxCliCredentialsCached({ ttlMs: EXTERNAL_CLI_SYNC_TTL_MS }),
  },
  {
    profileId: OPENAI_CODEX_DEFAULT_PROFILE_ID,
    provider: "openai-codex",
    readCredentials: () => readCodexCliCredentialsCached({ ttlMs: EXTERNAL_CLI_SYNC_TTL_MS }),
  },
];

function resolveExternalCliSyncProvider(params: {
  profileId: string;
  credential?: OAuthCredential;
}): ExternalCliSyncProvider | null {
  const provider = EXTERNAL_CLI_SYNC_PROVIDERS.find(
    (entry) => entry.profileId === params.profileId,
  );
  if (!provider) {
    return null;
  }
  if (params.credential && provider.provider !== params.credential.provider) {
    return null;
  }
  return provider;
}

export function readExternalCliBootstrapCredential(params: {
  profileId: string;
  credential: OAuthCredential;
}): OAuthCredential | null {
  const provider = resolveExternalCliSyncProvider(params);
  if (!provider) {
    return null;
  }
  return provider.readCredentials();
}

export const readManagedExternalCliCredential = readExternalCliBootstrapCredential;

export function resolveExternalCliAuthProfiles(
  store: AuthProfileStore,
): ExternalCliResolvedProfile[] {
  const profiles: ExternalCliResolvedProfile[] = [];
  const now = Date.now();
  for (const providerConfig of EXTERNAL_CLI_SYNC_PROVIDERS) {
    const creds = providerConfig.readCredentials();
    if (!creds) {
      continue;
    }
    const existing = store.profiles[providerConfig.profileId];
    const existingOAuth =
      existing?.type === "oauth" && existing.provider === providerConfig.provider
        ? existing
        : undefined;
    if (existing && !existingOAuth) {
      log.debug("kept explicit local auth over external cli bootstrap", {
        profileId: providerConfig.profileId,
        provider: providerConfig.provider,
        localType: existing.type,
        localProvider: existing.provider,
      });
      continue;
    }
    if (existingOAuth && !isSafeToUseExternalCliCredential(existingOAuth, creds)) {
      log.warn("refused external cli oauth bootstrap: identity mismatch", {
        profileId: providerConfig.profileId,
        provider: providerConfig.provider,
      });
      continue;
    }
    if (
      !shouldBootstrapFromExternalCliCredential({
        existing: existingOAuth,
        imported: creds,
        now,
      })
    ) {
      if (existingOAuth) {
        log.debug("kept usable local oauth over external cli bootstrap", {
          profileId: providerConfig.profileId,
          provider: providerConfig.provider,
          localExpires: existingOAuth.expires,
          externalExpires: creds.expires,
        });
      }
      continue;
    }
    log.debug("used external cli oauth bootstrap because local oauth was missing or unusable", {
      profileId: providerConfig.profileId,
      provider: providerConfig.provider,
      localExpires: existingOAuth?.expires,
      externalExpires: creds.expires,
    });
    profiles.push({
      profileId: providerConfig.profileId,
      credential: creds,
    });
  }
  return profiles;
}
