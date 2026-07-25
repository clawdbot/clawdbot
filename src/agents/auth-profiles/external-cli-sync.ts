/**
 * External CLI OAuth synchronization.
 * Reads supported CLI credential stores, decides whether those credentials can
 * safely bootstrap local auth profiles, and returns runtime/persisted overlays.
 */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import {
  readClaudeCliCredentialsCached,
  readCodexCliCredentialsCached,
  readMiniMaxCliCredentialsCached,
} from "../cli-credentials.js";
import {
  CLAUDE_CLI_PROFILE_ID,
  EXTERNAL_CLI_SYNC_TTL_MS,
  MINIMAX_CLI_PROFILE_ID,
  OPENAI_CODEX_DEFAULT_PROFILE_ID,
} from "./constants.js";
import { log } from "./constants.js";
import { isSafeToCopyOAuthIdentity } from "./oauth-identity.js";
import {
  areOAuthCredentialsEquivalent,
  hasUsableOAuthCredential,
  isSafeToAdoptBootstrapOAuthIdentity,
  shouldBootstrapFromExternalCliCredential,
} from "./oauth-shared.js";
import type { AuthProfileStore, OAuthCredential } from "./types.js";

type ExternalCliResolvedProfile = {
  profileId: string;
  credential: OAuthCredential;
  persistence?: "runtime-only" | "persisted";
};

type ExternalCliAuthProfileOptions = {
  allowKeychainPrompt?: boolean;
  providerIds?: Iterable<string>;
  profileIds?: Iterable<string>;
};

type ExternalCliSyncProvider = {
  profileId: string;
  profileAliases?: readonly string[];
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

// Keep this gate aligned with the canonical identity-copy rule in oauth.ts.
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

const EXTERNAL_CLI_SYNC_PROVIDERS: ExternalCliSyncProvider[] = [
  {
    profileId: OPENAI_CODEX_DEFAULT_PROFILE_ID,
    profileAliases: ["openai:default"],
    provider: "openai",
    aliases: ["openai", "codex", "codex-cli", "codex-app-server"],
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
  const provider = EXTERNAL_CLI_SYNC_PROVIDERS.find((entry) =>
    externalCliProfileIdMatches(entry, params.profileId),
  );
  if (!provider) {
    return null;
  }
  if (
    params.credential &&
    !listExternalCliProviderIds(provider).includes(params.credential.provider)
  ) {
    return null;
  }
  return provider;
}

function listExternalCliProfileIds(providerConfig: ExternalCliSyncProvider): string[] {
  return [providerConfig.profileId, ...(providerConfig.profileAliases ?? [])];
}

function listExternalCliProviderIds(providerConfig: ExternalCliSyncProvider): string[] {
  return [providerConfig.provider, ...(providerConfig.aliases ?? [])];
}

function normalizeExternalCliCredentialProvider(
  credential: OAuthCredential | null,
  provider: string,
): OAuthCredential | null {
  return credential ? { ...credential, provider } : null;
}

function getAuthProfileProviderPrefix(profileId: string): string {
  return profileId.split(":", 1)[0]?.trim() ?? "";
}

function externalCliProfileIdMatches(
  providerConfig: ExternalCliSyncProvider,
  profileId: string,
  options?: { allowLegacyNamespace?: boolean },
): boolean {
  if (listExternalCliProfileIds(providerConfig).includes(profileId)) {
    return true;
  }
  if (
    !options?.allowLegacyNamespace ||
    providerConfig.profileId !== OPENAI_CODEX_DEFAULT_PROFILE_ID
  ) {
    return false;
  }
  const normalizedPrefix = normalizeProviderId(getAuthProfileProviderPrefix(profileId));
  return normalizedPrefix === "openai";
}

function hasInlineOAuthTokenMaterial(credential: OAuthCredential): boolean {
  return [credential.access, credential.refresh, credential.idToken].some(
    (value) => typeof value === "string" && value.trim().length > 0,
  );
}

function hasManagedProviderOAuth(
  store: AuthProfileStore,
  providerConfig: ExternalCliSyncProvider,
): boolean {
  return Object.values(store.profiles).some(
    (credential) =>
      credential?.type === "oauth" &&
      listExternalCliProviderIds(providerConfig).includes(credential.provider) &&
      hasInlineOAuthTokenMaterial(credential),
  );
}

/** Read a CLI credential only for safe bootstrap of an unusable local profile. */
export function readExternalCliBootstrapCredential(params: {
  store: AuthProfileStore;
  profileId: string;
  credential: OAuthCredential;
  allowInlineOAuthTokenMaterial?: boolean;
  allowKeychainPrompt?: boolean;
}): OAuthCredential | null {
  const provider = resolveExternalCliSyncProvider(params);
  if (!provider) {
    return null;
  }
  if (provider.bootstrapOnly && hasManagedProviderOAuth(params.store, provider)) {
    return null;
  }
  if (
    provider.bootstrapOnly &&
    !params.allowInlineOAuthTokenMaterial &&
    hasInlineOAuthTokenMaterial(params.credential)
  ) {
    return null;
  }
  return normalizeExternalCliCredentialProvider(
    provider.readCredentials({ allowKeychainPrompt: params.allowKeychainPrompt }),
    params.credential.provider,
  );
}

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

function isExternalCliProviderInScope(params: {
  providerConfig: ExternalCliSyncProvider;
  store: AuthProfileStore;
  options?: ExternalCliAuthProfileOptions;
}): boolean {
  const { providerConfig, options, store } = params;
  const providerScope = normalizeProviderScope(options?.providerIds);
  if (providerScope === undefined && options?.profileIds === undefined) {
    return Object.entries(store.profiles).some(([profileId, existing]) => {
      return (
        externalCliProfileIdMatches(providerConfig, profileId) &&
        existing?.type === "oauth" &&
        listExternalCliProviderIds(providerConfig).includes(existing.provider)
      );
    });
  }
  if (
    Array.from(options?.profileIds ?? []).some((profileId) =>
      externalCliProfileIdMatches(providerConfig, profileId.trim(), {
        allowLegacyNamespace: true,
      }),
    )
  ) {
    return true;
  }
  if (!providerScope || providerScope.size === 0) {
    return false;
  }
  return listExternalCliProviderIds(providerConfig).some((alias) => {
    const raw = alias.trim().toLowerCase();
    const normalized = normalizeProviderId(alias);
    return providerScope.has(raw) || (normalized ? providerScope.has(normalized) : false);
  });
}

function listScopedExternalCliProfileIds(params: {
  providerConfig: ExternalCliSyncProvider;
  store: AuthProfileStore;
  options?: ExternalCliAuthProfileOptions;
}): string[] {
  const { options, providerConfig, store } = params;
  // Bootstrap-only CLI state must not enter any sibling slot once OpenClaw
  // owns OAuth for the provider, regardless of how discovery was scoped.
  if (providerConfig.bootstrapOnly && hasManagedProviderOAuth(store, providerConfig)) {
    return [];
  }

  const requestedProfileIds = Array.from(options?.profileIds ?? [])
    .map((value) => value.trim())
    .filter((value) => value.length > 0);
  if (requestedProfileIds.length > 0) {
    return requestedProfileIds.filter((profileId) =>
      externalCliProfileIdMatches(providerConfig, profileId, {
        allowLegacyNamespace: true,
      }),
    );
  }

  const existingProfileIds = Object.keys(store.profiles).filter((profileId) =>
    externalCliProfileIdMatches(providerConfig, profileId),
  );
  if (existingProfileIds.length > 0) {
    return existingProfileIds;
  }

  return options?.providerIds ? [providerConfig.profileId] : [];
}

function backfillExternalCliIdentity(params: {
  providerConfig: ExternalCliSyncProvider;
  existingOAuth: OAuthCredential;
  allowKeychainPrompt?: boolean;
}): OAuthCredential | null {
  if (params.existingOAuth.email) {
    return null;
  }
  const creds = params.providerConfig.readCredentials({
    allowKeychainPrompt: params.allowKeychainPrompt,
  });
  // Matching token material is the only proof the stored profile IS the CLI
  // login; identity fields are absent on the stored side by definition here.
  const sameLogin =
    creds?.email &&
    (creds.refresh === params.existingOAuth.refresh ||
      creds.access === params.existingOAuth.access);
  return sameLogin ? { ...params.existingOAuth, email: creds.email } : null;
}

/** Resolve scoped external CLI auth profiles available to overlay or persist. */
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
    const scopedProfileIds = listScopedExternalCliProfileIds({
      providerConfig,
      store,
      options,
    });
    for (const profileId of scopedProfileIds) {
      const existing = store.profiles[profileId];
      const existingOAuth =
        existing?.type === "oauth" &&
        listExternalCliProviderIds(providerConfig).includes(existing.provider)
          ? existing
          : undefined;
      if (existing && !existingOAuth) {
        log.debug("kept explicit local auth over external cli bootstrap", {
          profileId,
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
          profileId,
          provider: providerConfig.provider,
        });
        continue;
      }
      if (
        existingOAuth &&
        !providerConfig.bootstrapOnly &&
        hasUsableOAuthCredential(existingOAuth, now)
      ) {
        // Profiles synced before identity capture carry no email; backfill the
        // non-secret metadata once the CLI read proves it is the same login.
        const backfilled = backfillExternalCliIdentity({
          providerConfig,
          existingOAuth,
          allowKeychainPrompt: options?.allowKeychainPrompt,
        });
        if (backfilled) {
          profiles.push({ profileId, credential: backfilled, persistence: "persisted" });
        }
        continue;
      }
      const creds = normalizeExternalCliCredentialProvider(
        providerConfig.readCredentials({
          allowKeychainPrompt: options?.allowKeychainPrompt,
        }),
        existingOAuth?.provider ?? providerConfig.provider,
      );
      if (!creds) {
        continue;
      }
      if (existingOAuth && !isSafeToUseExternalCliCredential(existingOAuth, creds)) {
        log.warn("refused external cli oauth bootstrap: identity mismatch", {
          profileId,
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
          profileId,
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
            profileId,
            provider: providerConfig.provider,
            localExpires: existingOAuth.expires,
            externalExpires: creds.expires,
          });
        }
        continue;
      }
      log.debug("used external cli oauth bootstrap because local oauth was missing or unusable", {
        profileId,
        provider: providerConfig.provider,
        localExpires: existingOAuth?.expires,
        externalExpires: creds.expires,
      });
      profiles.push({
        profileId,
        credential: creds,
        persistence: providerConfig.bootstrapOnly ? "runtime-only" : "persisted",
      });
    }
  }
  return profiles;
}
