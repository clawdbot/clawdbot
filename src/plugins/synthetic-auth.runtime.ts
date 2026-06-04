/** Resolves synthetic and external auth provider refs from active runtime state or persisted manifests. */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import { loadPluginManifestRegistryForInstalledIndex } from "./manifest-registry-installed.js";
import { loadPluginRegistrySnapshotWithMetadata } from "./plugin-registry.js";
import type { LoadPluginRegistryParams, PluginRegistrySnapshot } from "./plugin-registry.js";
import { getPluginRegistryState } from "./runtime-state.js";

function uniqueProviderRefs(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const next: string[] = [];
  for (const raw of values) {
    const trimmed = raw.trim();
    const normalized = normalizeProviderId(trimmed);
    if (!trimmed || seen.has(normalized)) {
      continue;
    }
    seen.add(normalized);
    next.push(trimmed);
  }
  return next;
}

function resolveManifestSyntheticAuthProviderRefState(
  params: SyntheticAuthProviderRefParams = {},
): { refs: string[]; complete: boolean } {
  if (params.index && (params.registryDiagnostics?.length ?? 0) > 0) {
    return { refs: [], complete: false };
  }
  const result = loadPluginRegistrySnapshotWithMetadata(params);
  if (result.source !== "persisted" && result.source !== "provided") {
    return { refs: [], complete: false };
  }
  return {
    refs: uniqueProviderRefs(
      result.snapshot.plugins.flatMap((plugin) => plugin.syntheticAuthRefs ?? []),
    ),
    complete: true,
  };
}

type SyntheticAuthProviderRefParams = LoadPluginRegistryParams & {
  index?: PluginRegistrySnapshot;
  registryDiagnostics?: readonly unknown[];
};

function resolveManifestExternalAuthProviderRefs(
  params: SyntheticAuthProviderRefParams = {},
): string[] {
  if (params.index && (params.registryDiagnostics?.length ?? 0) > 0) {
    return [];
  }
  const result = loadPluginRegistrySnapshotWithMetadata(params);
  if (result.source !== "persisted" && result.source !== "provided") {
    return [];
  }
  const manifestRegistry = loadPluginManifestRegistryForInstalledIndex({
    index: result.snapshot,
  });
  return uniqueProviderRefs(
    manifestRegistry.plugins.flatMap((plugin) => plugin.contracts?.externalAuthProviders ?? []),
  );
}

/** Lists provider refs that can satisfy synthetic auth profile lookups. */
export function resolveRuntimeSyntheticAuthProviderRefs(
  params: SyntheticAuthProviderRefParams = {},
): string[] {
  return resolveRuntimeSyntheticAuthProviderRefState(params).refs;
}

/** Returns synthetic-auth refs plus whether the control-plane data source was complete. */
export function resolveRuntimeSyntheticAuthProviderRefState(
  params: SyntheticAuthProviderRefParams = {},
): { refs: string[]; complete: boolean } {
  const registry = getPluginRegistryState()?.activeRegistry;
  if (registry) {
    return {
      refs: uniqueProviderRefs([
        ...registry.plugins.flatMap((plugin) => plugin.syntheticAuthRefs ?? []),
        ...(registry.providers ?? [])
          .filter(
            (entry) =>
              "resolveSyntheticAuth" in entry.provider &&
              typeof entry.provider.resolveSyntheticAuth === "function",
          )
          .map((entry) => entry.provider.id),
        ...(registry.cliBackends ?? [])
          .filter(
            (entry) =>
              "resolveSyntheticAuth" in entry.backend &&
              typeof entry.backend.resolveSyntheticAuth === "function",
          )
          .map((entry) => entry.backend.id),
      ]),
      complete: true,
    };
  }
  return resolveManifestSyntheticAuthProviderRefState(params);
}

/** Lists provider refs that can expose external auth profiles to runtime consumers. */
export function resolveRuntimeExternalAuthProviderRefs(
  params: SyntheticAuthProviderRefParams = {},
): string[] {
  const registry = getPluginRegistryState()?.activeRegistry;
  if (registry) {
    return uniqueProviderRefs([
      ...registry.plugins.flatMap((plugin) => plugin.contracts?.externalAuthProviders ?? []),
      ...(registry.providers ?? [])
        .filter(
          (entry) =>
            ("resolveExternalAuthProfiles" in entry.provider &&
              typeof entry.provider.resolveExternalAuthProfiles === "function") ||
            ("resolveExternalOAuthProfiles" in entry.provider &&
              typeof entry.provider.resolveExternalOAuthProfiles === "function"),
        )
        .map((entry) => entry.provider.id),
      ...(registry.cliBackends ?? [])
        .filter(
          (entry) =>
            ("resolveExternalAuthProfiles" in entry.backend &&
              typeof entry.backend.resolveExternalAuthProfiles === "function") ||
            ("resolveExternalOAuthProfiles" in entry.backend &&
              typeof entry.backend.resolveExternalOAuthProfiles === "function"),
        )
        .map((entry) => entry.backend.id),
    ]);
  }
  return resolveManifestExternalAuthProviderRefs(params);
}
