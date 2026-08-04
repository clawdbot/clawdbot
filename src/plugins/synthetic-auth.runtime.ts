/** Resolves synthetic and external auth provider refs from active runtime state or persisted manifests. */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { PluginMetadataSnapshot } from "./plugin-metadata-snapshot.types.js";
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

/** Returns synthetic-auth refs only when the metadata registry is authoritative. */
export function resolveValidatedSyntheticAuthProviderRefState(
  snapshot: Pick<PluginMetadataSnapshot, "index" | "registryDiagnostics" | "registrySource">,
): { refs: string[]; complete: boolean } {
  const complete =
    snapshot.registryDiagnostics.length === 0 &&
    (snapshot.registrySource === "persisted" || snapshot.registrySource === "provided");
  if (!complete) {
    return { refs: [], complete: false };
  }
  return {
    refs: uniqueProviderRefs(
      snapshot.index.plugins
        .filter((plugin) => plugin.enabled)
        .flatMap((plugin) => plugin.syntheticAuthRefs ?? []),
    ),
    complete: true,
  };
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

/** Lists positive synthetic-auth candidates without treating derived absence as authoritative. */
function resolveRuntimeSyntheticAuthCandidateRefs(
  params: SyntheticAuthProviderRefParams = {},
): string[] {
  const registry = getPluginRegistryState()?.activeRegistry;
  const runtimeRefs = registry ? resolveRuntimeSyntheticAuthProviderRefState(params).refs : [];
  if (params.index && (params.registryDiagnostics?.length ?? 0) > 0) {
    return runtimeRefs;
  }
  const result = loadPluginRegistrySnapshotWithMetadata(params);
  return uniqueProviderRefs([
    ...runtimeRefs,
    ...result.snapshot.plugins.flatMap((plugin) => plugin.syntheticAuthRefs ?? []),
  ]);
}

/** Returns whether runtime or manifest metadata names one requested synthetic-auth ref. */
export function hasRuntimeSyntheticAuthCandidateRef(
  params: SyntheticAuthProviderRefParams & { providerRefs: readonly string[] },
): boolean {
  const candidates = new Set(
    resolveRuntimeSyntheticAuthCandidateRefs(params).map((ref) => normalizeProviderId(ref)),
  );
  return params.providerRefs.some((ref) => candidates.has(normalizeProviderId(ref)));
}

type SyntheticAuthProviderRefParams = LoadPluginRegistryParams & {
  index?: PluginRegistrySnapshot;
  registryDiagnostics?: readonly unknown[];
};

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
        ...registry.cliBackends
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
