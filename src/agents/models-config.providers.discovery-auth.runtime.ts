import type { OpenClawConfig } from "../config/types.openclaw.js";
import { coerceSecretRef } from "../config/types.secrets.js";
import { secretRefKey } from "../secrets/ref-contract.js";
import { resolveAuthProfileSecretOwnerId } from "../secrets/runtime-auth-profile-owner.js";
import { SecretSurfaceUnavailableError } from "../secrets/runtime-degraded-state.js";
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
    resolveProviderApiKey,
    resolveProviderAuth,
  }: {
    agentDir: string;
    authStore: AuthProfileStore;
    resolveProviderApiKey: ProviderApiKeyResolver;
    resolveProviderAuth: ProviderAuthResolver;
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
  const enrich = <T extends { profileId?: string }>(auth: T): T => {
    const resolve = auth.profileId ? profiles.get(auth.profileId) : undefined;
    return resolve ? { ...auth, discoveryApiKey: resolve() } : auth;
  };
  return {
    resolveProviderApiKey: (provider: string) => enrich(resolveProviderApiKey(provider)),
    resolveProviderAuth: (provider: string, options?: Parameters<ProviderAuthResolver>[1]) =>
      enrich(resolveProviderAuth(provider, options)),
  };
}
