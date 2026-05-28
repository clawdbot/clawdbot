import { resolveProviderSyntheticAuthWithPlugin } from "../plugins/provider-runtime.js";
import { resolveRuntimeSyntheticAuthProviderRefs } from "../plugins/synthetic-auth.runtime.js";
import {
  resolveAgentCredentialMapFromStore,
  type AgentCredentialMap,
} from "./agent-auth-credentials.js";
import {
  addEnvBackedAgentCredentials,
  type AgentDiscoveryAuthLookupOptions,
} from "./agent-auth-discovery-core.js";
import type { ExternalCliAuthDiscovery } from "./auth-profiles/external-cli-discovery.js";
import {
  ensureAuthProfileStore,
  ensureAuthProfileStoreWithoutExternalProfiles,
  loadAuthProfileStoreWithoutExternalProfiles,
  loadAuthProfileStoreForRuntime,
  loadAuthProfileStoreForSecretsRuntime,
} from "./auth-profiles/store.js";

export type DiscoverAuthStorageOptions = {
  externalCli?: ExternalCliAuthDiscovery;
  readOnly?: boolean;
  skipExternalAuthProfiles?: boolean;
  skipCredentials?: boolean;
  syntheticAuthProviderRefs?: Iterable<string>;
} & AgentDiscoveryAuthLookupOptions;

export function resolveAgentCredentialsForDiscovery(
  agentDir: string,
  options?: DiscoverAuthStorageOptions,
): AgentCredentialMap {
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
  const credentials = addEnvBackedAgentCredentials(
    resolveAgentCredentialMapFromStore(store, {
      includeSecretRefPlaceholders: options?.readOnly === true,
    }),
    {
      config: options?.config,
      workspaceDir: options?.workspaceDir,
      env: options?.env,
    },
  );
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
  addEnvBackedAgentCredentials,
  scrubLegacyStaticAuthJsonEntriesForDiscovery,
} from "./agent-auth-discovery-core.js";
