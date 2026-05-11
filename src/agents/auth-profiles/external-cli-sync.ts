import {
  readClaudeCliCredentialsCached,
  readCodexCliCredentialsCached,
  readMiniMaxCliCredentialsCached,
} from "../cli-credentials.js";
import { normalizeProviderId } from "../provider-id.js";
import {
  CLAUDE_CLI_PROFILE_ID,
  EXTERNAL_CLI_SYNC_TTL_MS,
  MINIMAX_CLI_PROFILE_ID,
  OPENAI_CODEX_DEFAULT_PROFILE_ID,
} from "./constants.js";
import { log } from "./constants.js";
import {
  areOAuthCredentialsEquivalent,
  hasUsableOAuthCredential,
  isSafeToAdoptBootstrapOAuthIdentity,
  shouldBootstrapFromExternalCliCredential,
} from "./oauth-shared.js";
import type { AuthProfileStore, OAuthCredential } from "./types.js";

export {
  areOAuthCredentialsEquivalent,
  hasUsableOAuthCredential,
  isSafeToAdoptBootstrapOAuthIdentity,
  isSafeToOverwriteStoredOAuthIdentity,
  shouldBootstrapFromExternalCliCredential,
  shouldReplaceStoredOAuthCredential,
} from "./oauth-shared.js";

export type ExternalCliResolvedProfile = {
  profileId: string;
  credential: OAuthCredential;
  persistence?: "runtime-only" | "persisted";
};

export type ExternalCliAuthProfileOptions = {
  allowKeychainPrompt?: boolean;
  providerIds?: Iterable<string>;
  profileIds?: Iterable<string>;
};

type ExternalCliSyncProvider = {
  profileId: string;
  provider: string;
  aliases?: readonly string[];
  readCredentials: (
    options?: Pick<ExternalCliAuthProfileOptions, "allowKeychainPrompt">,
  ) => OAuthCredential | null;
  // bootstrapOnly providers adopt the external CLI credential only to
  // seed an empty slot; once a local OAuth credential exists for the
  // profile, the local refresh token is treated as canonical and the
  // CLI state must not replace or shadow it. Codex requires this to
  // avoid clobbering a locally refreshed token with stale CLI state.
  bootstrapOnly?: boolean;
};

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

const EXTERNAL_CLI_SYNC_PROVIDERS: ExternalCliSyncProvider[] = [
  {
    profileId: OPENAI_CODEX_DEFAULT_PROFILE_ID,
    provider: "openai-codex",
    aliases: ["codex", "codex-cli", "codex-app-server"],
    readCredentials: (options) =>
      readCodexCliCredentialsCached({
        ttlMs: EXTERNAL_CLI_SYNC_TTL_MS,
        allowKeychainPrompt: options?.allowKeychainPrompt,
      }),
    bootstrapOnly: true,
  },
  {
    profileId: CLAUDE_CLI_PROFILE_ID,
    provider: "claude-cli",
    readCredentials: (options) => {
      const credential = readClaudeCliCredentialsCached({
        ttlMs: EXTERNAL_CLI_SYNC_TTL_MS,
        allowKeychainPrompt: options?.allowKeychainPrompt,
      });
      if (credential?.type !== "oauth") {
        return null;
      }
      return { ...credential, provider: "claude-cli" };
    },
  },
  {
    profileId: MINIMAX_CLI_PROFILE_ID,
    provider: "minimax-portal",
    aliases: ["minimax", "minimax-cli"],
    readCredentials: () => readMiniMaxCliCredentialsCached({ ttlMs: EXTERNAL_CLI_SYNC_TTL_MS }),
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

function hasInlineOAuthTokenMaterial(credential: OAuthCredential): boolean {
  return [credential.access, credential.refresh, credential.idToken].some(
    (value) => typeof value === "string" && value.trim().length > 0,
  );
}

export function readExternalCliBootstrapCredential(params: {
  profileId: string;
  credential: OAuthCredential;
}): OAuthCredential | null {
  const provider = resolveExternalCliSyncProvider(params);
  if (!provider) {
    return null;
  }
  if (provider.bootstrapOnly && hasInlineOAuthTokenMaterial(params.credential)) {
    return null;
  }
  return provider.readCredentials();
}

export const readManagedExternalCliCredential = readExternalCliBootstrapCredential;

function normalizeProviderScope(values: Iterable<string> | undefined): Set<string> | undefined {
  if (values === undefined) {
    return undefined;
  }
  const out = new Set<string>();
  for (const value of values) {
    const raw = value.trim();
    if (!raw) {
      continue;
    }
    out.add(raw.toLowerCase());
    const normalized = normalizeProviderId(raw);
    if (normalized) {
      out.add(normalized);
    }
  }
  return out;
}

function normalizeProfileScope(values: Iterable<string> | undefined): Set<string> | undefined {
  if (values === undefined) {
    return undefined;
  }
  const out = new Set<string>();
  for (const value of values) {
    const raw = value.trim().toLowerCase();
    if (raw) {
      out.add(raw);
    }
  }
  return out;
}

function isExternalCliProviderInScope(params: {
  providerConfig: ExternalCliSyncProvider;
  store: AuthProfileStore;
  options?: ExternalCliAuthProfileOptions;
}): boolean {
  const { providerConfig, options, store } = params;
  const providerScope = normalizeProviderScope(options?.providerIds);
  const profileScope = normalizeProfileScope(options?.profileIds);
  if (providerScope === undefined && profileScope === undefined) {
    const existing = store.profiles[providerConfig.profileId];
    return existing?.type === "oauth" && existing.provider === providerConfig.provider;
  }
  if (profileScope?.has(providerConfig.profileId.toLowerCase())) {
    return true;
  }
  if (!providerScope || providerScope.size === 0) {
    return false;
  }
  const aliases = [providerConfig.provider, ...(providerConfig.aliases ?? [])];
  return aliases.some((alias) => {
    const raw = alias.trim().toLowerCase();
    const normalized = normalizeProviderId(alias);
    return providerScope.has(raw) || (normalized ? providerScope.has(normalized) : false);
  });
}

export function resolveExternalCliAuthProfiles(
  store: AuthProfileStore,
  options?: ExternalCliAuthProfileOptions,
): ExternalCliResolvedProfile[] {
  const profiles: ExternalCliResolvedProfile[] = [];
  const now = Date.now();
  for (const providerConfig of EXTERNAL_CLI_SYNC_PROVIDERS) {
    if (!isExternalCliProviderInScope({ providerConfig, store, options })) {
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
    if (
      providerConfig.bootstrapOnly &&
      existingOAuth &&
      hasInlineOAuthTokenMaterial(existingOAuth)
    ) {
      log.debug("kept local oauth over external cli bootstrap-only provider", {
        profileId: providerConfig.profileId,
        provider: providerConfig.provider,
      });
      continue;
    }
    if (
      existingOAuth &&
      !providerConfig.bootstrapOnly &&
      hasUsableOAuthCredential(existingOAuth, now)
    ) {
      continue;
    }
    const creds = providerConfig.readCredentials({
      allowKeychainPrompt: options?.allowKeychainPrompt,
    });
    if (!creds) {
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
      existingOAuth &&
      !isSafeToAdoptBootstrapOAuthIdentity(existingOAuth, creds) &&
      !areOAuthCredentialsEquivalent(existingOAuth, creds)
    ) {
      log.warn("refused external cli oauth bootstrap: identity mismatch or missing binding", {
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
      persistence: providerConfig.bootstrapOnly ? "runtime-only" : "persisted",
    });
  }
  return profiles;
}
