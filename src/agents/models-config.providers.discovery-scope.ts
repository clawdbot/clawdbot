/** Resolves the plugin-owned provider scope for configured and live catalog discovery. */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { normalizeStringEntries } from "@openclaw/normalization-core/string-normalization";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import { resolveOwningPluginIdsForProviderRef } from "../plugins/providers.js";

export type ProviderDiscoveryScope = ReadonlyMap<string, readonly string[]>;

function resolveProviderDiscoveryScope(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
  resolveOwners?: (provider: string) => readonly string[] | undefined;
  providerIds?: readonly string[];
}): ProviderDiscoveryScope | undefined {
  const { config, workspaceDir, env } = params;
  const scopedProviderIds =
    params.providerIds !== undefined
      ? normalizeStringEntries([...params.providerIds])
          .map(normalizeProviderId)
          .filter(Boolean)
      : undefined;
  if (scopedProviderIds) {
    return buildProviderDiscoveryScope({
      providerIds: scopedProviderIds,
      config,
      workspaceDir,
      env,
      resolveOwners: params.resolveOwners,
    });
  }
  const live =
    env.OPENCLAW_LIVE_TEST === "1" || env.OPENCLAW_LIVE_GATEWAY === "1" || env.LIVE === "1";
  if (!live) {
    return undefined;
  }
  const rawValues = [
    env.OPENCLAW_LIVE_PROVIDERS?.trim(),
    env.OPENCLAW_LIVE_GATEWAY_PROVIDERS?.trim(),
  ].filter((value): value is string => Boolean(value && value !== "all"));
  if (rawValues.length === 0) {
    return undefined;
  }
  const ids = normalizeStringEntries(rawValues.flatMap((value) => value.split(",")))
    .map(normalizeProviderId)
    .filter(Boolean);
  if (ids.length === 0) {
    return undefined;
  }
  return buildProviderDiscoveryScope({
    providerIds: ids,
    config,
    workspaceDir,
    env,
    resolveOwners: params.resolveOwners,
  });
}

function buildProviderDiscoveryScope(params: {
  providerIds: readonly string[];
  config?: OpenClawConfig;
  workspaceDir?: string;
  env: NodeJS.ProcessEnv;
  resolveOwners?: (provider: string) => readonly string[] | undefined;
}): ProviderDiscoveryScope {
  const providerIds = [...new Set(params.providerIds)];
  const providerIdsByPluginId = new Map<string, string[]>();
  for (const id of providerIds) {
    const owners =
      params.resolveOwners?.(id) ??
      resolveOwningPluginIdsForProviderRef({
        provider: id,
        config: params.config,
        workspaceDir: params.workspaceDir,
        env: params.env,
      }) ??
      [];
    for (const pluginId of owners.length > 0 ? owners : [id]) {
      const ownedProviderIds = providerIdsByPluginId.get(pluginId) ?? [];
      if (!ownedProviderIds.includes(id)) {
        ownedProviderIds.push(id);
        providerIdsByPluginId.set(pluginId, ownedProviderIds);
      }
    }
  }
  return new Map(
    [...providerIdsByPluginId.entries()].toSorted(([left], [right]) => left.localeCompare(right)),
  );
}

function resolvePluginMetadataProviderOwners(
  pluginMetadataSnapshot: Pick<PluginMetadataSnapshot, "owners"> | undefined,
  provider: string,
): readonly string[] | undefined {
  if (!pluginMetadataSnapshot) {
    return undefined;
  }
  const normalizedProvider = normalizeProviderId(provider);
  if (!normalizedProvider) {
    return undefined;
  }
  const owners = new Set<string>();
  appendNormalizedPluginMetadataOwners(
    owners,
    pluginMetadataSnapshot.owners.providers ?? new Map(),
    provider,
    normalizedProvider,
  );
  appendNormalizedPluginMetadataOwners(
    owners,
    pluginMetadataSnapshot.owners.modelCatalogProviders ?? new Map(),
    provider,
    normalizedProvider,
  );
  appendNormalizedPluginMetadataOwners(
    owners,
    pluginMetadataSnapshot.owners.setupProviders ?? new Map(),
    provider,
    normalizedProvider,
  );
  appendNormalizedPluginMetadataOwners(
    owners,
    pluginMetadataSnapshot.owners.cliBackends ?? new Map(),
    provider,
    normalizedProvider,
  );
  return owners.size > 0
    ? [...owners].toSorted((left, right) => left.localeCompare(right))
    : undefined;
}

function appendNormalizedPluginMetadataOwners(
  target: Set<string>,
  ownerMap: ReadonlyMap<string, readonly string[]>,
  provider: string,
  normalizedProvider: string,
): void {
  for (const owner of ownerMap.get(provider) ?? []) {
    target.add(owner);
  }
  if (normalizedProvider !== provider) {
    for (const owner of ownerMap.get(normalizedProvider) ?? []) {
      target.add(owner);
    }
  }
  for (const [ownedId, owners] of ownerMap.entries()) {
    if (
      ownedId !== provider &&
      ownedId !== normalizedProvider &&
      normalizeProviderId(ownedId) === normalizedProvider
    ) {
      for (const owner of owners) {
        target.add(owner);
      }
    }
  }
}

export function resolveImplicitProviderDiscoveryScope(params: {
  config?: OpenClawConfig;
  workspaceDir?: string;
  env?: NodeJS.ProcessEnv;
  pluginMetadataSnapshot?: Pick<PluginMetadataSnapshot, "owners">;
  providerDiscoveryProviderIds?: readonly string[];
}): ProviderDiscoveryScope | undefined {
  return resolveProviderDiscoveryScope({
    config: params.config,
    workspaceDir: params.workspaceDir,
    env: params.env ?? process.env,
    resolveOwners: params.pluginMetadataSnapshot
      ? (provider) => resolvePluginMetadataProviderOwners(params.pluginMetadataSnapshot, provider)
      : undefined,
    providerIds: params.providerDiscoveryProviderIds,
  });
}
