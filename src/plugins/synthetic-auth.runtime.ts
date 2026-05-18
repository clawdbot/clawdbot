import { normalizeProviderId } from "../agents/provider-id.js";
import { loadPluginManifestRegistryForInstalledIndex } from "./manifest-registry-installed.js";
import { loadPluginRegistrySnapshotWithMetadata } from "./plugin-registry.js";
import type { PluginRegistrySnapshot } from "./plugin-registry.js";
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

function resolveManifestSyntheticAuthProviderRefs(
  params: {
    index?: PluginRegistrySnapshot;
    registryDiagnostics?: readonly unknown[];
  } = {},
): string[] {
  if (params.index && (params.registryDiagnostics?.length ?? 0) > 0) {
    return [];
  }
  const result = loadPluginRegistrySnapshotWithMetadata({ index: params.index });
  if (result.source !== "persisted" && result.source !== "provided") {
    return [];
  }
  return uniqueProviderRefs(
    result.snapshot.plugins.flatMap((plugin) => plugin.syntheticAuthRefs ?? []),
  );
}

function resolveManifestExternalAuthProviderRefs(
  params: {
    index?: PluginRegistrySnapshot;
    registryDiagnostics?: readonly unknown[];
  } = {},
): string[] {
  if (params.index && (params.registryDiagnostics?.length ?? 0) > 0) {
    return [];
  }
  const result = loadPluginRegistrySnapshotWithMetadata({ index: params.index });
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

export function resolveRuntimeSyntheticAuthProviderRefs(
  params: {
    index?: PluginRegistrySnapshot;
    registryDiagnostics?: readonly unknown[];
  } = {},
): string[] {
  const registry = getPluginRegistryState()?.activeRegistry;
  if (registry) {
    return uniqueProviderRefs([
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
    ]);
  }
  return resolveManifestSyntheticAuthProviderRefs({
    index: params.index,
    registryDiagnostics: params.registryDiagnostics,
  });
}

export function resolveRuntimeExternalAuthProviderRefs(
  params: {
    index?: PluginRegistrySnapshot;
    registryDiagnostics?: readonly unknown[];
  } = {},
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
  return resolveManifestExternalAuthProviderRefs({
    index: params.index,
    registryDiagnostics: params.registryDiagnostics,
  });
}
