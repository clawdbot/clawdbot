import { OAuthProviderRegistry } from "../../llm/utils/oauth/index.js";

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
