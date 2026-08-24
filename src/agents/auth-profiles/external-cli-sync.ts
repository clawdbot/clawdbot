/**
 * External CLI OAuth synchronization.
 * Reads supported CLI credential stores, decides whether those credentials can
 * safely bootstrap local auth profiles, and returns runtime/persisted overlays.
 */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import {
  readClaudeCliCredentialsCached,
  readClaudeCliCredentialsUncachedAsync,
  readCodexCliCredentialsCached,
  readMiniMaxCliCredentialsCached,
} from "../cli-credentials.js";
import {
  CLAUDE_CLI_PROFILE_ID,
  EXTERNAL_CLI_SYNC_TTL_MS,
  MINIMAX_CLI_PROFILE_ID,
  OPENAI_CODEX_DEFAULT_PROFILE_ID,
  authProfilesLog,
} from "./constants.js";
import { hasUsableOAuthCredential } from "./credential-state.js";
import { listExternalCliProfileMetadataIds } from "./external-cli-profile-metadata.js";
import { isSafeToCopyOAuthIdentity } from "./oauth-identity.js";
import {
  areOAuthCredentialsEquivalent,
  hasMatchingOAuthIdentity,
  isSafeToAdoptBootstrapOAuthIdentity,
  shouldBootstrapFromExternalCliCredential,
} from "./oauth-shared.js";
import type { AuthProfileCredential, AuthProfileStore, OAuthCredential } from "./types.js";

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
  // Uncached, non-prompting read used to prove refresh ownership. It must reach
  // every backend the CLI can store credentials in, including the macOS
  // Keychain, and must not reuse a cached value whose freshness is tracked by
  // file mtime alone. It is asynchronous because status callers run inside a
  // request and a Keychain lookup can block for seconds when the Keychain is
  // locked. Only providers that define it can own a persisted slot.
  readCurrentCredentials?: () => Promise<OAuthCredential | null>;
  // bootstrapOnly providers adopt the external CLI credential only to
  // seed an empty slot; once a local OAuth credential exists for the
  // profile, the local refresh token is treated as canonical and the
  // CLI state must not replace or shadow it. Codex requires this to
  // avoid clobbering a locally refreshed token with stale CLI state.
  bootstrapOnly?: boolean;
};

// Keep this gate aligned with the canonical identity-copy rule in oauth.ts.
// Also the passthrough gate in cli-runner/prepare.ts: a live CLI login that
// this sync would refuse to import must not authenticate a run either.
/** Return true when imported CLI credentials match an existing profile identity. */
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
    aliases: ["anthropic"],
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
    readCurrentCredentials: async () => {
      const credential = await readClaudeCliCredentialsUncachedAsync({
        allowKeychainPrompt: false,
        tryKeychainWithoutPrompt: true,
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

/** Provider ids whose external CLI credentials can be refreshed by this owner. */
export function listExternalCliSyncProviderIds(): string[] {
  return [...new Set(EXTERNAL_CLI_SYNC_PROVIDERS.flatMap(listExternalCliProviderIds))];
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

/** True when a previously resolved built-in CLI profile belongs to this refresh scope. */
export function isExternalCliAuthProfileInScope(params: {
  store: AuthProfileStore;
  profileId: string;
  providerIds?: Iterable<string>;
  profileIds?: Iterable<string>;
}): boolean {
  const credential = params.store.profiles[params.profileId];
  const providerConfig = resolveExternalCliSyncProvider({
    profileId: params.profileId,
    ...(credential?.type === "oauth" ? { credential } : {}),
  });
  return providerConfig
    ? isExternalCliProviderInScope({
        providerConfig,
        store: params.store,
        options: {
          ...(params.providerIds ? { providerIds: params.providerIds } : {}),
          ...(params.profileIds ? { profileIds: params.profileIds } : {}),
        },
      })
    : false;
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
  const matchingRequestedProfileIds = requestedProfileIds.filter((profileId) =>
    externalCliProfileIdMatches(providerConfig, profileId, { allowLegacyNamespace: true }),
  );
  if (matchingRequestedProfileIds.length > 0) {
    return matchingRequestedProfileIds;
  }

  const existingProfileIds = Object.keys(store.profiles).filter((profileId) =>
    externalCliProfileIdMatches(providerConfig, profileId),
  );
  if (existingProfileIds.length > 0) {
    return existingProfileIds;
  }

  return options?.providerIds ? [providerConfig.profileId] : [];
}

/**
 * True when the live external CLI still owns refresh for a persisted profile.
 *
 * An idle Claude CLI access token expires long before its refresh token does.
 * The CLI refreshes on its own schedule, so OpenClaw must not report that
 * credential as needing an operator re-login. Ownership is asserted only
 * against the current CLI read, so a logged-out, cleared, or re-logged-in CLI
 * still surfaces normally:
 *
 * - a current, uncached read of the CLI store, across every backend it may use,
 *   must still return an OAuth credential (a `claude logout` removes it, and
 *   ownership is refused),
 * - that credential must still carry refresh material, and
 * - its refresh material must match the persisted slot, which is the only proof
 *   that the stored profile IS this CLI login and that this refresh token is
 *   the one the CLI still rotates.
 *
 * A refresh token revoked server-side while the local file is untouched cannot
 * be detected without a network call; that matches existing behavior for a CLI
 * credential inside its validity window.
 */
// Auth health is rebuilt per request, so concurrent status calls land on the
// same expired profile and would each spawn their own credential-store read.
// Share the read already in flight and drop the entry the moment it settles.
// This deduplicates concurrent work without caching a result, so a logout that
// lands between two requests is still seen by the second one.
const inFlightExternalCliCredentialReads = new Map<string, Promise<OAuthCredential | null>>();

function readCurrentExternalCliCredentialOnce(
  profileId: string,
  read: () => Promise<OAuthCredential | null>,
): Promise<OAuthCredential | null> {
  const inFlight = inFlightExternalCliCredentialReads.get(profileId);
  if (inFlight) {
    return inFlight;
  }
  // Deferred through Promise.resolve so a synchronous throw still clears the
  // entry rather than wedging every later read behind a rejected promise.
  const pending = Promise.resolve()
    .then(read)
    .finally(() => {
      inFlightExternalCliCredentialReads.delete(profileId);
    });
  inFlightExternalCliCredentialReads.set(profileId, pending);
  return pending;
}

async function isLiveExternalCliRefreshOwner(params: {
  profileId: string;
  credential: AuthProfileCredential | undefined;
}): Promise<boolean> {
  const { credential } = params;
  if (credential?.type !== "oauth") {
    return false;
  }
  const providerConfig = resolveExternalCliSyncProvider({
    profileId: params.profileId,
    credential,
  });
  if (!providerConfig?.readCurrentCredentials || providerConfig.bootstrapOnly) {
    return false;
  }
  // A usable credential raises no re-login warning, so there is nothing to
  // suppress and no reason to pay for a credential read.
  if (hasUsableOAuthCredential(credential)) {
    return false;
  }
  const live = await readCurrentExternalCliCredentialOnce(
    params.profileId,
    providerConfig.readCurrentCredentials,
  );
  if (live?.type !== "oauth" || !live.refresh?.trim()) {
    return false;
  }
  // Refresh tokens rotate, so token equality alone expires as proof: once the
  // CLI rotates, a still-owned slot would start warning again. Identity is the
  // durable signal, and it is the same rule the sync layer already trusts to
  // decide a CLI credential may be imported over an existing profile.
  if (hasMatchingOAuthIdentity(credential, live)) {
    return true;
  }
  // With identity absent on either side, matching refresh material is the only
  // remaining proof. Access-token equality is deliberately not accepted: it
  // would leave the persisted refresh token unproven while suppressing an
  // expired-credential warning.
  return live.refresh === credential.refresh;
}

/**
 * Profile ids whose OAuth refresh the live external CLI still owns.
 *
 * Scoped to the canonical built-in CLI slot registry, so a user-owned profile
 * or another CLI provider keeps its expiry visible.
 *
 * `skipProfileIds` names profiles whose ownership is already established, and
 * they are filtered out before any credential read. A caller that already holds
 * runtime provenance must not pay for a credential-store lookup to learn what
 * it knows, and on macOS that lookup can wait on a locked Keychain.
 */
export async function listLiveExternalCliOwnedProfileIds(
  store: AuthProfileStore,
  options?: { skipProfileIds?: ReadonlySet<string> },
): Promise<string[]> {
  const owned = await Promise.all(
    listExternalCliProfileMetadataIds()
      .filter((profileId) => !options?.skipProfileIds?.has(profileId))
      .map(async (profileId) =>
        (await isLiveExternalCliRefreshOwner({
          profileId,
          credential: store.profiles[profileId],
        }))
          ? profileId
          : null,
      ),
  );
  return owned.filter((profileId) => profileId !== null).toSorted();
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
        authProfilesLog.debug("kept explicit local auth over external cli bootstrap", {
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
        authProfilesLog.debug("kept local oauth over external cli bootstrap-only provider", {
          profileId,
          provider: providerConfig.provider,
        });
        continue;
      }
      if (
        existingOAuth &&
        !providerConfig.bootstrapOnly &&
        hasUsableOAuthCredential(existingOAuth, { now })
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
        authProfilesLog.warn("refused external cli oauth bootstrap: identity mismatch", {
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
        authProfilesLog.warn(
          "refused external cli oauth bootstrap: identity mismatch or missing binding",
          {
            profileId,
            provider: providerConfig.provider,
          },
        );
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
          authProfilesLog.debug("kept usable local oauth over external cli bootstrap", {
            profileId,
            provider: providerConfig.provider,
            localExpires: existingOAuth.expires,
            externalExpires: creds.expires,
          });
        }
        continue;
      }
      authProfilesLog.debug(
        "used external cli oauth bootstrap because local oauth was missing or unusable",
        {
          profileId,
          provider: providerConfig.provider,
          localExpires: existingOAuth?.expires,
          externalExpires: creds.expires,
        },
      );
      profiles.push({
        profileId,
        credential: creds,
        persistence: providerConfig.bootstrapOnly ? "runtime-only" : "persisted",
      });
    }
  }
  return profiles;
}
