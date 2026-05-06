import { resolveProviderSyntheticAuthWithPlugin } from "../plugins/provider-runtime.js";
import { resolveRuntimeSyntheticAuthProviderRefs } from "../plugins/synthetic-auth.runtime.js";
import type { ExternalCliAuthDiscovery } from "./auth-profiles/external-cli-discovery.js";
import {
  ensureAuthProfileStore,
  ensureAuthProfileStoreWithoutExternalProfiles,
  loadAuthProfileStoreWithoutExternalProfiles,
  loadAuthProfileStoreForRuntime,
  loadAuthProfileStoreForSecretsRuntime,
} from "./auth-profiles/store.js";
import { resolvePiCredentialMapFromStore, type PiCredentialMap } from "./pi-auth-credentials.js";
import {
  addEnvBackedPiCredentials,
  type PiDiscoveryAuthLookupOptions,
} from "./pi-auth-discovery-core.js";

export type DiscoverAuthStorageOptions = {
  externalCli?: ExternalCliAuthDiscovery;
  readOnly?: boolean;
  skipExternalAuthProfiles?: boolean;
  skipCredentials?: boolean;
  syntheticAuthProviderRefs?: Iterable<string>;
} & PiDiscoveryAuthLookupOptions;

export function resolvePiCredentialsForDiscovery(
  agentDir: string,
  options?: DiscoverAuthStorageOptions,
): PiCredentialMap {
  const storeOptions = {
    allowKeychainPrompt: false,
    ...(options?.config ? { config: options.config } : {}),
    ...(options?.externalCli ? { externalCli: options.externalCli } : {}),
  };
  const store =
    options?.skipExternalAuthProfiles === true
      ? options.readOnly === true
        ? loadAuthProfileStoreWithoutExternalProfiles(agentDir)
        : ensureAuthProfileStoreWithoutExternalProfiles(agentDir, {
            allowKeychainPrompt: false,
          })
      : options?.readOnly === true
        ? options.externalCli || options.config
          ? loadAuthProfileStoreForRuntime(agentDir, { readOnly: true, ...storeOptions })
          : loadAuthProfileStoreForSecretsRuntime(agentDir)
        : ensureAuthProfileStore(agentDir, storeOptions);
  const credentials = addEnvBackedPiCredentials(resolvePiCredentialMapFromStore(store), {
    config: options?.config,
    workspaceDir: options?.workspaceDir,
    env: options?.env,
  });
  const syntheticAuthProviderRefs =
    options?.syntheticAuthProviderRefs ?? resolveRuntimeSyntheticAuthProviderRefs();
  for (const provider of syntheticAuthProviderRefs) {
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
