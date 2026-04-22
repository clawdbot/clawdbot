import { normalizeProviderId } from "../agents/model-selection.js";
import type { ModelProviderConfig } from "../config/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ProviderDiscoveryOrder, ProviderPlugin } from "./types.js";

const DISCOVERY_ORDER: readonly ProviderDiscoveryOrder[] = ["simple", "profile", "paired", "late"];
const DANGEROUS_PROVIDER_KEYS = new Set(["__proto__", "prototype", "constructor"]);
let providerRuntimePromise: Promise<typeof import("./provider-discovery.runtime.js")> | undefined;

function loadProviderRuntime() {
  providerRuntimePromise ??= import("./provider-discovery.runtime.js");
  return providerRuntimePromise;
}

function resolveProviderCatalogHook(provider: ProviderPlugin) {
  return provider.catalog ?? provider.discovery;
}

function resolveProviderCatalogOrderHook(provider: ProviderPlugin) {
  return resolveProviderCatalogHook(provider) ?? provider.staticCatalog;
}

function createProviderConfigRecord(): Record<string, ModelProviderConfig> {
  return Object.create(null) as Record<string, ModelProviderConfig>;
}

function isSafeProviderConfigKey(value: string): boolean {
  return value !== "" && !DANGEROUS_PROVIDER_KEYS.has(value);
}

export async function resolvePluginDiscoveryProviders(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  onlyPluginIds?: string[];
  includeUntrustedWorkspacePlugins?: boolean;
  requireCompleteDiscoveryEntryCoverage?: boolean;
}): Promise<ProviderPlugin[]> {
  return (await loadProviderRuntime())
    .resolvePluginDiscoveryProvidersRuntime(params)
    .filter((provider) => resolveProviderCatalogOrderHook(provider));
}

export function groupPluginDiscoveryProvidersByOrder(
  providers: ProviderPlugin[],
): Record<ProviderDiscoveryOrder, ProviderPlugin[]> {
  const grouped = {
    simple: [],
    profile: [],
    paired: [],
    late: [],
  } as Record<ProviderDiscoveryOrder, ProviderPlugin[]>;

  for (const provider of providers) {
    const order = resolveProviderCatalogOrderHook(provider)?.order ?? "late";
    grouped[order].push(provider);
  }

  for (const order of DISCOVERY_ORDER) {
    grouped[order].sort((a, b) => a.label.localeCompare(b.label));
  }

  return grouped;
}

export function normalizePluginDiscoveryResult(params: {
  provider: ProviderPlugin;
  result:
    | { provider: ModelProviderConfig }
    | { providers: Record<string, ModelProviderConfig> }
    | null
    | undefined;
}): Record<string, ModelProviderConfig> {
  const result = params.result;
  if (!result) {
    return {};
  }

  if ("provider" in result) {
    const normalized = createProviderConfigRecord();
    for (const providerId of [
      params.provider.id,
      ...(params.provider.aliases ?? []),
      ...(params.provider.hookAliases ?? []),
    ]) {
      const normalizedKey = normalizeProviderId(providerId);
      if (!isSafeProviderConfigKey(normalizedKey)) {
        continue;
      }
      normalized[normalizedKey] = result.provider;
    }
    return normalized;
  }

  const normalized = createProviderConfigRecord();
  for (const [key, value] of Object.entries(result.providers)) {
    const normalizedKey = normalizeProviderId(key);
    if (!isSafeProviderConfigKey(normalizedKey) || !value) {
      continue;
    }
    normalized[normalizedKey] = value;
  }
  return normalized;
}

export function runProviderCatalog(params: {
  provider: ProviderPlugin;
  config: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
  resolveProviderApiKey: (providerId?: string) => {
    apiKey: string | undefined;
    discoveryApiKey?: string;
  };
  resolveProviderAuth: (
    providerId?: string,
    options?: { oauthMarker?: string },
  ) => {
    apiKey: string | undefined;
    discoveryApiKey?: string;
    mode: "api_key" | "oauth" | "token" | "none";
    source: "env" | "profile" | "none";
    profileId?: string;
  };
}) {
  return resolveProviderCatalogHook(params.provider)?.run({
    config: params.config,
    agentDir: params.agentDir,
    workspaceDir: params.workspaceDir,
    env: params.env,
    resolveProviderApiKey: params.resolveProviderApiKey,
    resolveProviderAuth: params.resolveProviderAuth,
  });
}

export function runProviderStaticCatalog(params: {
  provider: ProviderPlugin;
  config: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
}) {
  return params.provider.staticCatalog?.run({
    config: {},
    env: {},
    resolveProviderApiKey: () => ({
      apiKey: undefined,
    }),
    resolveProviderAuth: () => ({
      apiKey: undefined,
      mode: "none",
      source: "none",
    }),
  });
}
