// Resolves provider thinking-level policy from active plugins or plugin metadata.
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { ModelCatalogEntry, ModelCatalogSnapshot } from "../agents/model-catalog.types.js";
import { getCurrentPluginMetadataSnapshot } from "./current-plugin-metadata-snapshot.js";
import { getPluginMetadataSnapshotCache, withPluginCache } from "./plugin-cache.js";
import type { PluginMetadataSnapshot } from "./plugin-metadata-snapshot.types.js";
import { resolveProviderPolicySurface } from "./provider-public-artifacts.js";
import { matchesProviderPluginRef } from "./provider-registry-shared.js";
import { resolveActiveProviderThinkingProfile } from "./provider-thinking-active.js";
import {
  PREPARED_THINKING_POLICY,
  type PreparedThinkingPolicy,
  type ThinkingCatalogPolicyCarrier,
} from "./provider-thinking-catalog.js";
import type {
  ProviderDefaultThinkingPolicyContext,
  ProviderThinkingRegistry,
} from "./provider-thinking.types.js";

/** Capture policy before publication; row projections cannot activate a lazy provider. */
export function prepareModelCatalogThinkingPolicies(params: {
  catalog: ModelCatalogSnapshot;
  metadataSnapshot: PluginMetadataSnapshot;
  providers?: ProviderThinkingRegistry["providers"];
}): void {
  const policies = new Map<string, PreparedThinkingPolicy | null>();
  withPluginCache(getPluginMetadataSnapshotCache(params.metadataSnapshot), () => {
    const ownedEntries = new Map<ModelCatalogEntry, ModelCatalogEntry>();
    const capture = (entry: ModelCatalogEntry): ModelCatalogEntry => {
      const existing = ownedEntries.get(entry);
      if (existing) {
        return existing;
      }
      const provider = normalizeProviderId(entry.thinkingPolicyProvider ?? entry.provider);
      if (!policies.has(provider)) {
        const runtimeProvider = params.providers?.find(({ provider: candidate }) =>
          matchesProviderPluginRef(candidate, provider),
        )?.provider;
        policies.set(
          provider,
          runtimeProvider?.resolveThinkingProfile ??
            resolveProviderPolicySurface(provider, {
              manifestRegistry: params.metadataSnapshot.manifestRegistry,
            })?.resolveThinkingProfile ??
            null,
        );
      }
      // Configured rows can be shared across generations. Bind a private copy so
      // publishing another owner cannot replace the policy behind retained rows.
      const owned = { ...entry, [PREPARED_THINKING_POLICY]: policies.get(provider) ?? null };
      ownedEntries.set(entry, owned);
      return owned;
    };
    params.catalog.entries = params.catalog.entries.map(capture);
    params.catalog.routeVariants = params.catalog.routeVariants.map(capture);
    if (params.catalog.staticEntries) {
      params.catalog.staticEntries = params.catalog.staticEntries.map(capture);
    }
  });
}

function resolveProviderPublicPolicySurface(providerId: string) {
  const metadataSnapshot = getCurrentPluginMetadataSnapshot({
    allowScopedSnapshot: true,
    allowWorkspaceScopedSnapshot: true,
  });
  return resolveProviderPolicySurface(providerId, {
    manifestRegistry: metadataSnapshot?.manifestRegistry,
  });
}

type ThinkingHookParams<TContext> = {
  provider: string;
  context: TContext;
  catalogEntry?: ThinkingCatalogPolicyCarrier;
};

/** Resolves a provider thinking profile from active plugins or bundled policy surface. */
export function resolveEffectiveThinkingProfile(
  params: ThinkingHookParams<ProviderDefaultThinkingPolicyContext>,
  options?: { allowPublicArtifactFallback?: boolean; registry?: ProviderThinkingRegistry },
) {
  // The catalog's exact provider owner outranks ambient runtime registration.
  // Keep this process-local so worker transport and public catalog JSON stay data-only.
  const preparedPolicy = params.catalogEntry?.[PREPARED_THINKING_POLICY];
  if (preparedPolicy !== undefined) {
    return preparedPolicy?.(params.context);
  }
  const activeProfile = resolveActiveProviderThinkingProfile(params, options?.registry);
  if (activeProfile !== undefined) {
    return activeProfile;
  }
  // A captured owner is authoritative even when its registry has no matching hook.
  if (options?.registry || options?.allowPublicArtifactFallback === false) {
    return undefined;
  }
  return resolveProviderPublicPolicySurface(params.provider)?.resolveThinkingProfile?.(
    params.context,
  );
}
