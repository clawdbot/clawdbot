/** Discovers agent runtime credentials from auth profiles, env, and synthetic providers. */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import {
  prepareProviderSyntheticAuthWithPlugin,
  resolveProviderSyntheticAuthWithPlugin,
} from "../plugins/provider-runtime.js";
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
  preparedStore?: AuthProfileStore;
  readOnly?: boolean;
  skipExternalAuthProfiles?: boolean;
  skipCredentials?: boolean;
  syntheticAuthProviderRefs?: Iterable<string>;
} & AgentDiscoveryAuthLookupOptions;

type SyntheticAuth = { apiKey?: string } | undefined;
type AmbientAgentCredentialOptions = AgentDiscoveryAuthLookupOptions & {
  authoritativeSyntheticAuthProviderRefs?: Iterable<string>;
  resolveSyntheticAuth?: (provider: string) => SyntheticAuth;
  syntheticAuthProviderRefs?: Iterable<string>;
};

function resolveAmbientCredentialInputs(
  options: Omit<AmbientAgentCredentialOptions, "resolveSyntheticAuth">,
) {
  const credentials = addEnvBackedAgentCredentials({}, options);
  const syntheticAuthProviderRefs =
    options.syntheticAuthProviderRefs ?? resolveRuntimeSyntheticAuthProviderRefs();
  const authoritativeSyntheticAuthProviderRefs = new Set(
    [...(options.authoritativeSyntheticAuthProviderRefs ?? [])]
      .map(normalizeProviderId)
      .filter(Boolean),
  );
  // CLI-runtime authentication is a separate authority. Aliased provider
  // credentials must not suppress or replace native account checks.
  for (const provider of authoritativeSyntheticAuthProviderRefs) {
    delete credentials[provider];
  }
  const providers: string[] = [];
  for (const provider of syntheticAuthProviderRefs) {
    const normalizedProvider = normalizeProviderId(provider);
    if (!authoritativeSyntheticAuthProviderRefs.has(normalizedProvider) && credentials[provider]) {
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
    providers.push(provider);
  }
  return { credentials, providers };
}

function syntheticAuthParams(options: AgentDiscoveryAuthLookupOptions, provider: string) {
  return {
    config: options.config,
    workspaceDir: options.workspaceDir,
    env: options.env,
    provider,
    context: {
      config: options.config,
      provider,
      providerConfig: options.config?.models?.providers?.[provider],
    },
  };
}

function addSyntheticCredential(
  credentials: AgentCredentialMap,
  provider: string,
  resolved: SyntheticAuth,
) {
  const apiKey = resolved?.apiKey?.trim();
  if (apiKey) {
    credentials[normalizeProviderId(provider) || provider] = { type: "api_key", key: apiKey };
  }
}

/** Reads prepared workspace/config/env credentials independently of agent-local profiles. */
export function resolveAmbientAgentCredentialsForDiscovery(
  options: AmbientAgentCredentialOptions = {},
): AgentCredentialMap {
  const { credentials, providers } = resolveAmbientCredentialInputs(options);
  for (const provider of providers) {
    addSyntheticCredential(
      credentials,
      provider,
      options.resolveSyntheticAuth
        ? options.resolveSyntheticAuth(provider)
        : resolveProviderSyntheticAuthWithPlugin(syntheticAuthParams(options, provider)),
    );
  }
  return credentials;
}

/** Prepares external availability before publishing a generation's synchronous auth facts. */
export async function prepareAmbientAgentCredentialsForDiscovery(
  options: Omit<AmbientAgentCredentialOptions, "resolveSyntheticAuth"> & {
    resolveSyntheticAuth?: (provider: string) => Promise<SyntheticAuth>;
    signal?: AbortSignal;
  } = {},
): Promise<AgentCredentialMap> {
  const { credentials, providers } = resolveAmbientCredentialInputs(options);
  for (const provider of providers) {
    options.signal?.throwIfAborted();
    const resolved = options.resolveSyntheticAuth
      ? await options.resolveSyntheticAuth(provider)
      : await prepareProviderSyntheticAuthWithPlugin({
          ...syntheticAuthParams(options, provider),
          signal: options.signal,
        });
    options.signal?.throwIfAborted();
    addSyntheticCredential(credentials, provider, resolved);
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
  const store = options?.preparedStore
    ? options.preparedStore
    : options?.skipExternalAuthProfiles === true
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
