/** Discovers agent runtime credentials from auth profiles, env, and synthetic providers. */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { ProviderSyntheticAuthResult } from "../plugins/provider-external-auth.types.js";
import { resolveProviderSyntheticAuthWithPlugin } from "../plugins/provider-runtime.js";
import { resolveRuntimeSyntheticAuthProviderRefs } from "../plugins/synthetic-auth.runtime.js";
import type { PreparedProviderAuth } from "./agent-auth-credential-modes.js";
import {
  resolveAgentCredentialMapFromStore,
  resolveProviderAuthFacts,
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
import { resolveCanonicalProviderAuthId } from "./provider-auth-aliases.js";

/** Options for discovering credentials without prompting for secret material. */
export type DiscoverAuthStorageOptions = {
  ambientCredentials?: AgentDiscoveryAuthFacts;
  externalCli?: ExternalCliAuthDiscovery;
  inheritedAuthDir?: string;
  preparedStore?: AuthProfileStore;
  readOnly?: boolean;
  skipExternalAuthProfiles?: boolean;
  skipCredentials?: boolean;
  syntheticAuthProviderRefs?: Iterable<string>;
} & AgentDiscoveryAuthLookupOptions;

type AmbientAgentCredentialOptions = AgentDiscoveryAuthLookupOptions & {
  authoritativeSyntheticAuthProviderRefs?: Iterable<string>;
  canonicalProvider?: (provider: string) => string;
  nativeRuntime?: (provider: string) => string | undefined;
  resolveSyntheticAuth?: (provider: string) => ProviderSyntheticAuthResult | null | undefined;
  syntheticAuthProviderRefs?: Iterable<string>;
};

type AgentDiscoveryAuthFacts = {
  credentials: AgentCredentialMap;
  providerAuth: PreparedProviderAuth;
};

/** Resolves workspace/config/env-stable credentials independently of agent-local profiles. */
export function resolveAmbientAgentCredentialsForDiscovery(
  options: AmbientAgentCredentialOptions = {},
): AgentDiscoveryAuthFacts {
  const credentials = addEnvBackedAgentCredentials({}, options);
  const providerAuth: Record<string, PreparedProviderAuth[string]> = {
    ...resolveProviderAuthFacts(credentials),
  };
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
    const resolved = resolveSyntheticAuth(provider);
    if (!resolved) {
      continue;
    }
    const apiKey = resolved.apiKey.trim();
    if (!apiKey) {
      continue;
    }
    const canonicalProvider =
      options.canonicalProvider?.(provider) ?? resolveCanonicalProviderAuthId(provider);
    const runtime = resolved.runtime ?? options.nativeRuntime?.(provider);
    credentials[canonicalProvider] = {
      type: "api_key",
      key: apiKey,
    };
    providerAuth[canonicalProvider] = {
      mode: resolved.mode === "api-key" ? "api_key" : resolved.mode,
      ...(runtime ? { runtime } : {}),
    };
  }
  return { credentials, providerAuth: Object.freeze(providerAuth) };
}

/** Resolves the effective auth store and provider credentials for one discovery generation. */
export function resolveAgentDiscoveryAuthFacts(
  agentDir: string,
  options?: DiscoverAuthStorageOptions,
): {
  store: AuthProfileStore;
  credentials: AgentCredentialMap;
  providerAuth: PreparedProviderAuth;
} {
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
  const storedCredentials = resolveAgentCredentialMapFromStore(store, {
    includeSecretRefPlaceholders: options?.readOnly === true,
    config: options?.config,
  });
  const credentials = { ...storedCredentials };
  const ambientAuth =
    options?.ambientCredentials ??
    resolveAmbientAgentCredentialsForDiscovery({
      config: options?.config,
      workspaceDir: options?.workspaceDir,
      env: options?.env,
      syntheticAuthProviderRefs: options?.syntheticAuthProviderRefs,
    });
  for (const [provider, credential] of Object.entries(ambientAuth.credentials)) {
    if (credentials[provider]) {
      continue;
    }
    // Ambient auth is a lifecycle-owned fallback. Agent-local profiles remain authoritative.
    credentials[provider] = credential;
  }
  const providerAuth: Record<string, PreparedProviderAuth[string]> = {
    ...resolveProviderAuthFacts(credentials),
  };
  const storedProviders = new Set(Object.keys(storedCredentials));
  for (const [provider, auth] of Object.entries(ambientAuth.providerAuth)) {
    if (!storedProviders.has(provider)) {
      providerAuth[provider] = auth;
    }
  }
  return { store, credentials, providerAuth: Object.freeze(providerAuth) };
}
