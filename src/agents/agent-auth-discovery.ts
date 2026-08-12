/** Discovers agent runtime credentials from auth profiles, env, and synthetic providers. */
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
import { isAmbientCredentialAllowedByProviderAuthPin } from "./auth-profiles/ambient-auth.js";
import type { ExternalCliAuthDiscovery } from "./auth-profiles/external-cli-discovery.js";
import {
  ensureAuthProfileStore,
  ensureAuthProfileStoreWithoutExternalProfiles,
} from "./auth-profiles/store.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";

/** Options for discovering credentials without prompting for secret material. */
export type DiscoverAuthStorageOptions = {
  ambientCredentials?: Readonly<AgentCredentialMap>;
  externalCli?: ExternalCliAuthDiscovery;
  inheritedAuthDir?: string;
  readOnly?: boolean;
  skipExternalAuthProfiles?: boolean;
  skipCredentials?: boolean;
  syntheticAuthProviderRefs?: Iterable<string>;
} & AgentDiscoveryAuthLookupOptions;

type AmbientAgentCredentialOptions = AgentDiscoveryAuthLookupOptions & {
  resolveSyntheticAuth?: (provider: string) => { apiKey?: string } | undefined;
  syntheticAuthProviderRefs?: Iterable<string>;
};

/** Resolves workspace/config/env-stable credentials independently of agent-local profiles. */
export function resolveAmbientAgentCredentialsForDiscovery(
  options: AmbientAgentCredentialOptions = {},
): AgentCredentialMap {
  const credentials = addEnvBackedAgentCredentials({}, options);
  const syntheticAuthProviderRefs =
    options.syntheticAuthProviderRefs ?? resolveRuntimeSyntheticAuthProviderRefs();
  const resolveSyntheticAuth =
    options.resolveSyntheticAuth ??
    ((provider: string) =>
      resolveProviderSyntheticAuthWithPlugin({
        provider,
        config: options.config,
        workspaceDir: options.workspaceDir,
        env: options.env,
        context: {
          config: options.config,
          provider,
          providerConfig: options.config?.models?.providers?.[provider],
        },
      }));
  for (const provider of syntheticAuthProviderRefs) {
    if (credentials[provider]) {
      continue;
    }
    if (
      !isAmbientCredentialAllowedByProviderAuthPin({
        config: options.config,
        authAliasLookupParams: {
          ...(options.env ? { env: options.env } : {}),
          ...(options.workspaceDir ? { workspaceDir: options.workspaceDir } : {}),
        },
        provider,
        type: "api_key",
      })
    ) {
      continue;
    }
    const resolved = resolveSyntheticAuth(provider);
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

/** Resolves the effective auth store and provider credentials for one discovery generation. */
export function resolveAgentDiscoveryAuthFacts(
  agentDir: string,
  options?: DiscoverAuthStorageOptions,
): { store: AuthProfileStore; credentials: AgentCredentialMap } {
  const storeOptions = {
    allowKeychainPrompt: false,
    ...(options?.config ? { config: options.config } : {}),
    ...(options?.externalCli ? { externalCli: options.externalCli } : {}),
    ...(options?.inheritedAuthDir ? { inheritedAuthDir: options.inheritedAuthDir } : {}),
  };
  const store =
    options?.skipExternalAuthProfiles === true
      ? ensureAuthProfileStoreWithoutExternalProfiles(agentDir, {
          allowKeychainPrompt: false,
          ...(options?.inheritedAuthDir ? { inheritedAuthDir: options.inheritedAuthDir } : {}),
          ...(options?.readOnly === true ? { readOnly: true } : {}),
        })
      : ensureAuthProfileStore(agentDir, {
          ...storeOptions,
          ...(options?.readOnly === true ? { readOnly: true } : {}),
        });
  const credentials = resolveAgentCredentialMapFromStore(store, {
    includeSecretRefPlaceholders: options?.readOnly === true,
    config: options?.config,
  });
  const ambientCredentials =
    options?.ambientCredentials ??
    resolveAmbientAgentCredentialsForDiscovery({
      config: options?.config,
      workspaceDir: options?.workspaceDir,
      env: options?.env,
      syntheticAuthProviderRefs: options?.syntheticAuthProviderRefs,
    });
  for (const [provider, credential] of Object.entries(ambientCredentials)) {
    if (credentials[provider]) {
      continue;
    }
    // Ambient auth is a lifecycle-owned fallback. Agent-local profiles remain authoritative.
    credentials[provider] = credential;
  }
  return { store, credentials };
}

/** Resolves agent credentials from auth profiles, env, and synthetic auth hooks. */
export function resolveAgentCredentialsForDiscovery(
  agentDir: string,
  options?: DiscoverAuthStorageOptions,
): AgentCredentialMap {
  return resolveAgentDiscoveryAuthFacts(agentDir, options).credentials;
}
