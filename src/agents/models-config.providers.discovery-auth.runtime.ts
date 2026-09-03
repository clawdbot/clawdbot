import type { OpenClawConfig } from "../config/types.openclaw.js";
import { coerceSecretRef } from "../config/types.secrets.js";
import { secretRefKey } from "../secrets/ref-contract.js";
import { resolveAuthProfileSecretOwnerId } from "../secrets/runtime-auth-profile-owner.js";
import { SecretSurfaceUnavailableError } from "../secrets/runtime-degraded-state.js";
import { hasUsableOAuthCredential } from "./auth-profiles/credential-state.js";
import { resolveApiKeyForProfile } from "./auth-profiles/oauth.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import type {
  ProviderApiKeyResolver,
  ProviderAuthResolver,
} from "./models-config.providers.secret-helpers.js";

/** Prepares transient auth facts without changing synchronous catalog callback contracts. */
export async function prepareProviderDiscoveryAuth(
  {
    agentDir,
    authStore,
    providerIds,
    resolveProviderApiKey,
    resolveProviderAuth,
    resolveProviderAuthProviderId,
  }: {
    agentDir: string;
    authStore: AuthProfileStore;
    providerIds: readonly string[];
    resolveProviderApiKey: ProviderApiKeyResolver;
    resolveProviderAuth: ProviderAuthResolver;
    resolveProviderAuthProviderId: (provider: string) => string;
  },
  config?: OpenClawConfig,
) {
  const profiles = new Map<string, () => string>();
  for (const [profileId, credential] of Object.entries(authStore.profiles)) {
    const field = credential.type === "api_key" ? "key" : "token";
    const ref = coerceSecretRef(
      credential.type === "api_key"
        ? credential.keyRef
        : credential.type === "token"
          ? credential.tokenRef
          : undefined,
      config?.secrets?.defaults,
    );
    if (!ref || ref.source === "env") {
      continue;
    }
    try {
      // Only the canonical owner may redeem this exact profile's published ref.
      // OAuth/env/plain profiles retain their existing discovery semantics.
      const resolved = await resolveApiKeyForProfile({
        cfg: config,
        store: authStore,
        profileId,
        agentDir,
        allowProfileFallback: false,
      });
      if (!resolved) {
        throw new SecretSurfaceUnavailableError({
          ownerKind: "account",
          ownerId: resolveAuthProfileSecretOwnerId({ agentDir, profileId }),
          state: "unavailable",
          paths: [`auth-profiles.${profileId}.${field}`],
          refKeys: [secretRefKey(ref)],
          reason: "resolved secret value was invalid",
        });
      }
      profiles.set(profileId, () => resolved.apiKey);
    } catch (error) {
      // An unused account must not break another provider. Surface its failure
      // only when a callback selects that exact profile, before HTTP can run.
      profiles.set(profileId, () => {
        throw error;
      });
    }
  }
  const failedOAuthProfiles = new Map<string, readonly string[]>();
  for (const provider of new Set(providerIds.map(resolveProviderAuthProviderId))) {
    const failed: string[] = [];
    while (true) {
      let auth: ReturnType<ProviderAuthResolver>;
      try {
        auth = resolveProviderAuth(provider, { excludeProfileIds: failed });
      } catch {
        break;
      }
      if (!auth.profileId || auth.mode !== "oauth") {
        break;
      }
      const credential = authStore.profiles[auth.profileId];
      if (credential?.type !== "oauth" || credential.oauthRef) {
        break;
      }
      if (hasUsableOAuthCredential(credential)) {
        break;
      }
      try {
        const resolved = await resolveApiKeyForProfile({
          cfg: config,
          store: authStore,
          profileId: auth.profileId,
          agentDir,
          allowProfileFallback: false,
        });
        if (!resolved?.apiKey) {
          throw new Error("OAuth profile did not resolve a usable catalog credential");
        }
        profiles.set(auth.profileId, () => resolved.apiKey);
        break;
      } catch {
        failed.push(auth.profileId);
      }
    }
    if (failed.length > 0) {
      failedOAuthProfiles.set(provider, failed);
    }
  }
  const enrich = <T extends { profileId?: string }>(auth: T): T => {
    const resolve = auth.profileId ? profiles.get(auth.profileId) : undefined;
    return resolve ? { ...auth, discoveryApiKey: resolve() } : auth;
  };
  return {
    resolveProviderApiKey: (provider: string) => enrich(resolveProviderApiKey(provider)),
    resolveProviderAuth: (provider: string, options?: { oauthMarker?: string }) =>
      enrich(
        resolveProviderAuth(provider, {
          ...options,
          excludeProfileIds: failedOAuthProfiles.get(resolveProviderAuthProviderId(provider)),
        }),
      ),
  };
}
