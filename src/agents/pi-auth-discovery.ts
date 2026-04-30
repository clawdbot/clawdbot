import { resolveProviderSyntheticAuthWithPlugin } from "../plugins/provider-runtime.js";
import { resolveRuntimeSyntheticAuthProviderRefs } from "../plugins/synthetic-auth.runtime.js";
import {
  ensureAuthProfileStore,
  loadAuthProfileStoreForSecretsRuntime,
} from "./auth-profiles/store.js";
import { resolvePiCredentialMapFromStore, type PiCredentialMap } from "./pi-auth-credentials.js";
import {
  addEnvBackedPiCredentials,
  type PiDiscoveryAuthLookupOptions,
} from "./pi-auth-discovery-core.js";

export type DiscoverAuthStorageOptions = {
  readOnly?: boolean;
  skipCredentials?: boolean;
} & PiDiscoveryAuthLookupOptions;

export function resolvePiCredentialsForDiscovery(
  agentDir: string,
  options?: DiscoverAuthStorageOptions,
): PiCredentialMap {
  const store =
    options?.readOnly === true
      ? loadAuthProfileStoreForSecretsRuntime(agentDir)
      : ensureAuthProfileStore(agentDir, { allowKeychainPrompt: false });
  const credentials = addEnvBackedPiCredentials(resolvePiCredentialMapFromStore(store), {
    config: options?.config,
    workspaceDir: options?.workspaceDir,
    env: options?.env,
  });
  for (const provider of resolveRuntimeSyntheticAuthProviderRefs()) {
    if (credentials[provider]) {
      continue;
    }
    const resolved = resolveProviderSyntheticAuthWithPlugin({
      provider,
      context: {
        config: undefined,
        provider,
        providerConfig: undefined,
      },
    });
    const apiKey = resolved?.apiKey?.trim();
    if (!apiKey) {
      continue;
    }
    credentials[provider] = {
      type: "api_key",
      key: apiKey,
    };
  }
  return credentials;
}

export {
  addEnvBackedPiCredentials,
  scrubLegacyStaticAuthJsonEntriesForDiscovery,
} from "./pi-auth-discovery-core.js";
