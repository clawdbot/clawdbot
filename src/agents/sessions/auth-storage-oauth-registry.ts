import { OAuthProviderRegistry } from "../../llm/utils/oauth/index.js";
import type {
  OAuthCredentials,
  OAuthLoginCallbacks,
  OAuthProviderId,
} from "../../llm/utils/oauth/types.js";
import { OAuthProviderConfiguredUnavailableError } from "../../plugins/provider-runtime.errors.js";
import { loginProviderOAuthWithPlugin } from "../../plugins/provider-runtime.runtime.js";
import { prepareOAuthCredentialResolver } from "../auth-profiles/oauth.js";
import type { OAuthCredential as AuthProfileOAuthCredential } from "../auth-profiles/types.js";

// Values belong to one AuthStorage object. The weak attachment keeps ModelRegistry
// on the same registry without adding lifecycle methods to the public SDK class.
const registries = new WeakMap<object, OAuthProviderRegistry>();

type PreparedAuthStorageOAuthCredentialContext = { signal?: AbortSignal };
type PreparedAuthStorageOAuthCredentialResolver = (
  credential: OAuthCredentials,
  context?: PreparedAuthStorageOAuthCredentialContext,
) => Promise<{ apiKey: string; newCredentials: OAuthCredentials } | null>;

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

export async function prepareAuthStorageOAuthCredentialResolver(
  authStorage: object,
  providerId: OAuthProviderId,
  credential: OAuthCredentials,
): Promise<PreparedAuthStorageOAuthCredentialResolver> {
  const registered = getAuthStorageOAuthProviderRegistry(authStorage).prepareApiKey(providerId);
  if (registered) {
    return registered;
  }
  const prepared = await prepareOAuthCredentialResolver({
    ...credential,
    type: "oauth",
    provider: providerId,
  });
  return async (current, context = {}) => {
    const resolved = await prepared(
      {
        ...current,
        type: "oauth",
        provider: providerId,
      } satisfies AuthProfileOAuthCredential,
      context,
    );
    return resolved ? { apiKey: resolved.apiKey, newCredentials: resolved.credential } : null;
  };
}
