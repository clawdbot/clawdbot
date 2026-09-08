import { OAuthProviderRegistry } from "../../llm/utils/oauth/index.js";
import type {
  OAuthCredentials,
  OAuthLoginCallbacks,
  OAuthProviderId,
} from "../../llm/utils/oauth/types.js";
import { OAuthProviderConfiguredUnavailableError } from "../../plugins/provider-runtime.errors.js";
import {
  loginProviderOAuthWithPlugin,
  resolveProviderOAuthCredentialWithPlugin,
  resolveProviderOAuthRefreshCapabilityWithPlugin,
} from "../../plugins/provider-runtime.runtime.js";

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

export async function loginAuthStorageOAuthProvider(
  authStorage: object,
  providerId: OAuthProviderId,
  callbacks: OAuthLoginCallbacks,
): Promise<OAuthCredentials> {
  const provider = getAuthStorageOAuthProviderRegistry(authStorage).get(providerId);
  if (provider) {
    return await provider.login(callbacks);
  }
  const resolved = await loginProviderOAuthWithPlugin({ provider: providerId, context: callbacks });
  if (resolved.status === "unowned") {
    throw new Error(`Unknown OAuth provider: ${providerId}`);
  }
  if (resolved.status !== "available") {
    throw new OAuthProviderConfiguredUnavailableError(providerId);
  }
  return resolved.credentials;
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

export async function canResolveAuthStoragePluginOAuthRefresh(
  providerId: OAuthProviderId,
): Promise<boolean> {
  const capability = await resolveProviderOAuthRefreshCapabilityWithPlugin({
    provider: providerId,
  });
  if (capability.status === "configured-unavailable") {
    throw new OAuthProviderConfiguredUnavailableError(providerId);
  }
  return capability.status === "available";
}
