import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { resolveDefaultAgentDir } from "../agents/agent-scope.js";
import { ensureAuthProfileStoreWithoutExternalProfiles } from "../agents/auth-profiles.js";
import type { ModelCatalogEntry } from "../agents/model-catalog.js";
import { normalizeConfiguredProviderCatalogModelId } from "../agents/model-ref-shared.js";
import {
  createProviderApiKeyResolver,
  createProviderAuthResolver,
} from "../agents/models-config.providers.secrets.js";
import { resolveProviderCatalogPluginIdsForFilter } from "../commands/models/list.provider-catalog.js";
import type { ModelDefinitionConfig, ModelProviderConfig } from "../config/types.models.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { formatErrorMessage } from "../infra/errors.js";
import { createSubsystemLogger } from "../logging/subsystem.js";
import {
  groupPluginDiscoveryProvidersByOrder,
  normalizePluginDiscoveryResult,
  resolveRuntimePluginDiscoveryProviders,
  runProviderCatalog,
} from "../plugins/provider-discovery.js";
import type { ProviderPlugin } from "../plugins/types.js";

const log = createSubsystemLogger("model-picker-provider-catalog");
const DISCOVERY_ORDERS = ["simple", "profile", "paired", "late"] as const;

function providerMatchesFilter(params: {
  provider: Pick<ProviderPlugin, "id" | "aliases" | "hookAliases">;
  providerFilter: string;
}): boolean {
  return [
    params.provider.id,
    ...(params.provider.aliases ?? []),
    ...(params.provider.hookAliases ?? []),
  ].some((providerId) => normalizeProviderId(providerId) === params.providerFilter);
}

function positiveNumber(value: number | undefined): number | undefined {
  return typeof value === "number" && value > 0 ? value : undefined;
}

function providerAuthIds(provider: ProviderPlugin): string[] {
  return [provider.id, ...(provider.aliases ?? []), ...(provider.hookAliases ?? [])]
    .map(normalizeProviderId)
    .filter(Boolean);
}

function hasLiveProviderCatalog(provider: ProviderPlugin): boolean {
  return (
    typeof provider.catalog?.run === "function" || typeof provider.discovery?.run === "function"
  );
}

async function resolvePreferredProviderLiveCatalogProviders(params: {
  cfg: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  onlyPluginIds: string[];
  providerFilter: string;
  workspaceDir?: string;
}): Promise<ProviderPlugin[]> {
  const providers = (
    await resolveRuntimePluginDiscoveryProviders({
      config: params.cfg,
      env: params.env,
      onlyPluginIds: params.onlyPluginIds,
      includeUntrustedWorkspacePlugins: false,
      ...(params.workspaceDir !== undefined ? { workspaceDir: params.workspaceDir } : {}),
    })
  ).filter((provider) =>
    providerMatchesFilter({ provider, providerFilter: params.providerFilter }),
  );
  const liveProviders = providers.filter(hasLiveProviderCatalog);
  if (liveProviders.length > 0) {
    return liveProviders;
  }

  const { resolvePluginProviders } = await import("../plugins/providers.runtime.js");
  return resolvePluginProviders({
    config: params.cfg,
    env: params.env,
    onlyPluginIds: params.onlyPluginIds,
    includeUntrustedWorkspacePlugins: false,
    mode: "setup",
    activate: false,
    cache: false,
    ...(params.workspaceDir !== undefined ? { workspaceDir: params.workspaceDir } : {}),
  }).filter(
    (provider) =>
      providerMatchesFilter({ provider, providerFilter: params.providerFilter }) &&
      hasLiveProviderCatalog(provider),
  );
}

function resolveProviderEnvApiKey(
  provider: ProviderPlugin,
  env: NodeJS.ProcessEnv,
):
  | {
      apiKey: string;
      discoveryApiKey?: string;
    }
  | undefined {
  for (const envVar of provider.envVars ?? []) {
    const normalized = envVar.trim();
    const value = env[normalized]?.trim();
    if (normalized && value) {
      return {
        apiKey: value,
        discoveryApiKey: value,
      };
    }
  }
  return undefined;
}

function modelFromProviderCatalog(params: {
  provider: string;
  providerConfig: ModelProviderConfig;
  model: ModelDefinitionConfig;
}): ModelCatalogEntry {
  const id = normalizeConfiguredProviderCatalogModelId(params.provider, params.model.id);
  const contextWindow =
    positiveNumber(params.model.contextWindow) ??
    positiveNumber(params.providerConfig.contextWindow);
  const contextTokens =
    positiveNumber(params.model.contextTokens) ??
    positiveNumber(params.providerConfig.contextTokens);
  return {
    id,
    name: params.model.name || id,
    provider: params.provider,
    ...(contextWindow !== undefined ? { contextWindow } : {}),
    ...(contextTokens !== undefined ? { contextTokens } : {}),
    reasoning: params.model.reasoning,
    input: params.model.input,
    ...(params.model.compat ? { compat: params.model.compat } : {}),
  };
}

export async function loadPreferredProviderPickerCatalog(params: {
  cfg: OpenClawConfig;
  preferredProvider: string;
  agentDir?: string;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
}): Promise<ModelCatalogEntry[]> {
  const env = params.env ?? process.env;
  const agentDir = params.agentDir ?? resolveDefaultAgentDir(params.cfg, env);
  const providerFilter = normalizeProviderId(params.preferredProvider);
  if (!providerFilter) {
    return [];
  }

  const onlyPluginIds = await resolveProviderCatalogPluginIdsForFilter({
    cfg: params.cfg,
    env,
    providerFilter,
  });
  if (!onlyPluginIds || onlyPluginIds.length === 0) {
    return [];
  }

  const providers = await resolvePreferredProviderLiveCatalogProviders({
    cfg: params.cfg,
    env,
    onlyPluginIds,
    providerFilter,
    ...(params.workspaceDir !== undefined ? { workspaceDir: params.workspaceDir } : {}),
  });
  if (providers.length === 0) {
    return [];
  }

  let authStore: ReturnType<typeof ensureAuthProfileStoreWithoutExternalProfiles> | undefined;
  const getAuthStore = () =>
    (authStore ??= ensureAuthProfileStoreWithoutExternalProfiles(agentDir, {
      allowKeychainPrompt: false,
    }));
  const resolveProviderApiKey = createProviderApiKeyResolver(env, getAuthStore, params.cfg);
  const resolveProviderAuth = createProviderAuthResolver(env, getAuthStore, params.cfg);
  const resolveFastProviderApiKey = (provider: ProviderPlugin, providerId = provider.id) => {
    const normalizedProviderId = normalizeProviderId(providerId);
    if (providerAuthIds(provider).includes(normalizedProviderId)) {
      const fromEnv = resolveProviderEnvApiKey(provider, env);
      if (fromEnv) {
        return fromEnv;
      }
    }
    return resolveProviderApiKey(providerId);
  };
  const byOrder = groupPluginDiscoveryProvidersByOrder(providers);
  const rows: ModelCatalogEntry[] = [];
  const seen = new Set<string>();

  for (const order of DISCOVERY_ORDERS) {
    for (const provider of byOrder[order]) {
      let result: Awaited<ReturnType<typeof runProviderCatalog>>;
      const resolveCatalogProviderApiKey = (providerId?: string) =>
        resolveFastProviderApiKey(provider, providerId?.trim() || provider.id);
      const resolveCatalogProviderAuth = (
        providerId?: string,
        options?: { oauthMarker?: string },
      ) => resolveProviderAuth(providerId?.trim() || provider.id, options);
      try {
        result = await runProviderCatalog({
          provider,
          config: params.cfg,
          env,
          resolveProviderApiKey: resolveCatalogProviderApiKey,
          resolveProviderAuth: resolveCatalogProviderAuth,
          agentDir,
          ...(params.workspaceDir !== undefined ? { workspaceDir: params.workspaceDir } : {}),
        });
      } catch (error) {
        log.warn(`provider catalog failed for ${provider.id}: ${formatErrorMessage(error)}`);
        continue;
      }

      const normalized = normalizePluginDiscoveryResult({ provider, result });
      for (const [providerIdRaw, providerConfig] of Object.entries(normalized)) {
        const providerId = normalizeProviderId(providerIdRaw);
        if (providerId !== providerFilter || !Array.isArray(providerConfig.models)) {
          continue;
        }
        for (const model of providerConfig.models) {
          const entry = modelFromProviderCatalog({
            provider: providerId,
            providerConfig,
            model,
          });
          const key = `${entry.provider}/${entry.id}`;
          if (seen.has(key)) {
            continue;
          }
          seen.add(key);
          rows.push(entry);
        }
      }
    }
  }

  return rows;
}
