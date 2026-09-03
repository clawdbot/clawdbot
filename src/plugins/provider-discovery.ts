/** Control-plane provider discovery helpers that keep runtime imports lazy until catalog hooks run. */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { ModelProviderConfig } from "../config/types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { createLazyImportLoader } from "../shared/lazy-promise.js";
import type { PluginMetadataRegistryView } from "./plugin-metadata-snapshot.types.js";
import {
  copyProviderCatalogOutcomes,
  copyProviderCatalogResultProjection,
} from "./provider-catalog-result.js";
import type { ProviderCatalogContext, ProviderCatalogOutcome } from "./provider-catalog.types.js";
import type { ProviderCatalogOrder, ProviderPlugin } from "./types.js";

const DISCOVERY_ORDER: readonly ProviderCatalogOrder[] = ["simple", "profile", "paired", "late"];
const DANGEROUS_PROVIDER_KEYS = new Set(["__proto__", "prototype", "constructor"]);
const providerRuntimeLoader = createLazyImportLoader(
  () => import("./provider-discovery.runtime.js"),
);

function loadProviderRuntime() {
  return providerRuntimeLoader.load();
}

function resolveProviderCatalogHook(provider: ProviderPlugin) {
  return provider.catalog;
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

function providerCatalogIdentityKeys(params: {
  provider: ProviderPlugin;
  providerId?: string;
  resolveProviderAuthProviderId?: (providerId?: string) => string;
}): string[] {
  const requestedId = params.providerId?.trim() || params.provider.id;
  const requested = normalizeProviderId(requestedId);
  const authProvider = normalizeProviderId(
    params.resolveProviderAuthProviderId?.(requestedId) ?? requestedId,
  );
  return [...new Set([requested, authProvider])];
}

type PreparedProviderStaticCatalogEntry = Readonly<{
  provider: ProviderPlugin;
  result: Awaited<ReturnType<typeof runProviderStaticCatalog>>;
}>;

export type PreparedProviderStaticCatalog = Readonly<{
  /** Provider handles captured for this config/workspace generation. */
  providers?: readonly ProviderPlugin[];
  entries: readonly PreparedProviderStaticCatalogEntry[];
}>;

/** Options for resolving plugin providers that can contribute model catalog entries. */
export type ResolveRuntimePluginDiscoveryProvidersParams = {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  onlyPluginIds?: string[];
  includeUntrustedWorkspacePlugins?: boolean;
  requireCompleteDiscoveryEntryCoverage?: boolean;
  discoveryEntriesOnly?: boolean;
  includeManifestModelCatalogProviders?: boolean;
  includeSyntheticAuthProviders?: boolean;
  pluginMetadataSnapshot?: PluginMetadataRegistryView;
};

export type ProviderDiscoveryPlan =
  | { kind: "entries"; providers: ProviderPlugin[] }
  | { kind: "runtime"; providers: ProviderPlugin[]; pluginIds: string[] | undefined };

export async function planRuntimePluginDiscovery(
  params: ResolveRuntimePluginDiscoveryProvidersParams,
): Promise<ProviderDiscoveryPlan> {
  return (await loadProviderRuntime()).planPluginDiscoveryRuntime(params);
}

/** Loads provider runtime discovery and filters to providers that can produce catalog order entries. */
export async function resolveRuntimePluginDiscoveryProviders(
  params: ResolveRuntimePluginDiscoveryProvidersParams,
): Promise<ProviderPlugin[]> {
  return (await loadProviderRuntime())
    .resolvePluginDiscoveryProvidersRuntime(params)
    .filter(
      (provider) =>
        resolveProviderCatalogOrderHook(provider) ||
        (params.includeSyntheticAuthProviders === true &&
          (typeof provider.resolveSyntheticAuth === "function" ||
            typeof provider.prepareSyntheticAuth === "function")),
    );
}

/** Groups plugin providers into stable discovery phases for catalog probing. */
export function groupPluginDiscoveryProvidersByOrder(
  providers: ProviderPlugin[],
): Record<ProviderCatalogOrder, ProviderPlugin[]> {
  const grouped = {
    simple: [],
    profile: [],
    paired: [],
    late: [],
  } as Record<ProviderCatalogOrder, ProviderPlugin[]>;

  for (const provider of providers) {
    const order = resolveProviderCatalogOrderHook(provider)?.order ?? "late";
    grouped[order].push(provider);
  }

  for (const order of DISCOVERY_ORDER) {
    grouped[order].sort((a, b) => a.label.localeCompare(b.label));
  }

  return grouped;
}

/** Normalizes a plugin discovery response into safe provider-config keys. */
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

  const projection = copyProviderCatalogResultProjection(result);
  if (projection.kind === "provider") {
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
      normalized[normalizedKey] = projection.provider;
    }
    return normalized;
  }

  const normalized = createProviderConfigRecord();
  if (projection.kind !== "providers") {
    return normalized;
  }
  for (const [key, value] of projection.providers) {
    const normalizedKey = normalizeProviderId(key);
    if (!isSafeProviderConfigKey(normalizedKey) || !value) {
      continue;
    }
    normalized[normalizedKey] = value;
  }
  return normalized;
}

export async function runProviderCatalog(params: {
  provider: ProviderPlugin;
  providerIds?: readonly string[];
  config: OpenClawConfig;
  agentDir?: string;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
  resolveProviderApiKey: ProviderCatalogContext["resolveProviderApiKey"];
  resolveProviderAuth: ProviderCatalogContext["resolveProviderAuth"];
  resolveProviderAuthProviderId?: (providerId?: string) => string;
  reportCatalogOutcome?: (outcome: ProviderCatalogOutcome) => void;
}) {
  const hook = resolveProviderCatalogHook(params.provider);
  if (!hook) {
    return undefined;
  }
  // Hooks may compare credentials before choosing one, so retain every profile
  // they inspect. Profile-scoped outcomes require one unique resolved identity.
  const selectedProfiles = new Map<string, Set<string>>();
  const captureSelectedProfile = <T extends { profileId?: string }>(
    providerId: string | undefined,
    auth: T,
  ): T => {
    const profileId = auth.profileId?.trim();
    if (!profileId) {
      return auth;
    }
    for (const providerKey of providerCatalogIdentityKeys({
      provider: params.provider,
      providerId,
      resolveProviderAuthProviderId: params.resolveProviderAuthProviderId,
    })) {
      const profiles = selectedProfiles.get(providerKey) ?? new Set<string>();
      profiles.add(profileId);
      selectedProfiles.set(providerKey, profiles);
    }
    return auth;
  };
  const result = await hook.run({
    config: params.config,
    agentDir: params.agentDir,
    workspaceDir: params.workspaceDir,
    env: params.env,
    ...(params.providerIds !== undefined ? { providerIds: params.providerIds } : {}),
    resolveProviderApiKey: (providerId) =>
      captureSelectedProfile(providerId, params.resolveProviderApiKey(providerId)),
    resolveProviderAuth: (providerId, options) =>
      captureSelectedProfile(providerId, params.resolveProviderAuth(providerId, options)),
  });
  for (const outcome of copyProviderCatalogOutcomes(result)) {
    if (outcome.profileId) {
      const selected = new Set<string>();
      for (const providerKey of providerCatalogIdentityKeys({
        provider: params.provider,
        providerId: outcome.provider,
        resolveProviderAuthProviderId: params.resolveProviderAuthProviderId,
      })) {
        for (const profileId of selectedProfiles.get(providerKey) ?? []) {
          selected.add(profileId);
        }
      }
      if (selected.size !== 1 || !selected.has(outcome.profileId)) {
        throw new Error(
          `Provider catalog outcome did not match the selected authentication profile (${outcome.provider})`,
        );
      }
    }
    if (
      params.providerIds !== undefined &&
      !params.providerIds.some(
        (providerId) => normalizeProviderId(providerId) === normalizeProviderId(outcome.provider),
      )
    ) {
      continue;
    }
    params.reportCatalogOutcome?.(outcome);
  }
  return result;
}

export function runProviderStaticCatalog(params: { provider: ProviderPlugin }) {
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

/**
 * Runs sterile provider catalogs once so lifecycle owners can reuse the immutable results.
 * Providers remain attached to their plugin identity for later agent-specific scope filtering.
 */
export async function prepareProviderStaticCatalog(params: {
  providers: readonly ProviderPlugin[];
}): Promise<PreparedProviderStaticCatalog> {
  const entries: PreparedProviderStaticCatalogEntry[] = [];
  const byOrder = groupPluginDiscoveryProvidersByOrder([...params.providers]);
  for (const order of DISCOVERY_ORDER) {
    for (const provider of byOrder[order]) {
      if (!provider.staticCatalog) {
        continue;
      }
      entries.push(
        Object.freeze({
          provider,
          result: await runProviderStaticCatalog({ provider }),
        }),
      );
    }
  }
  return Object.freeze({
    providers: Object.freeze([...params.providers]),
    entries: Object.freeze(entries),
  });
}
