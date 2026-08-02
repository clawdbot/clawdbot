import { OAuthProviderRegistry } from "../../llm/utils/oauth/index.js";
import type { OAuthCredentials, OAuthProviderId } from "../../llm/utils/oauth/types.js";
import { OAuthProviderConfiguredUnavailableError } from "../../plugins/provider-runtime.errors.js";
import { resolveProviderOAuthCredentialWithPlugin } from "../../plugins/provider-runtime.runtime.js";

// Values belong to one AuthStorage object. The weak attachment keeps ModelRegistry
// on the same registry without adding lifecycle methods to the public SDK class.
const registries = new WeakMap<object, OAuthProviderRegistry>();

export function getAuthStorageOAuthProviderRegistry(authStorage: object): OAuthProviderRegistry {
  let registry = registries.get(authStorage);
  if (!registry) {
    registry = new OAuthProviderRegistry();
    registries.set(authStorage, registry);
  }
  return registry;
}

export async function resolveAuthStoragePluginOAuthCredential(
  providerId: OAuthProviderId,
  credential: OAuthCredentials,
  refresh: boolean,
): Promise<{ apiKey: string; newCredentials: OAuthCredentials } | null> {
  const resolved = await resolveProviderOAuthCredentialWithPlugin({
    provider: providerId,
    credential: { ...credential, type: "oauth", provider: providerId },
    refresh,
  });
  if (resolved.status === "configured-unavailable") {
    throw new OAuthProviderConfiguredUnavailableError(providerId);
  }
  return resolved.status === "available"
    ? { apiKey: resolved.apiKey, newCredentials: resolved.credential }
    : null;
}
