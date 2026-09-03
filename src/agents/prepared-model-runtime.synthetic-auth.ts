/** Synthetic-auth provider ref selection and prepared-catalog resolution for model-runtime builds. */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.types.js";
import type { ProviderSyntheticAuthResult } from "../plugins/provider-external-auth.types.js";
import { resolveProviderSyntheticAuthWithPlugin } from "../plugins/provider-runtime.js";
import type { ProviderPlugin } from "../plugins/types.js";

// Provider-scoped live builds must not fan ambient synthetic-auth discovery out to every
// registered provider; each unscoped ref can force a full plugin module load on the read path.
export function scopeSyntheticAuthProviderRefs(
  refs: readonly string[],
  providerDiscoveryProviderIds: readonly string[] | undefined,
): string[] {
  if (!providerDiscoveryProviderIds) {
    return [...refs];
  }
  const scoped = new Set(providerDiscoveryProviderIds.map((id) => normalizeProviderId(id)));
  return refs.filter((ref) => scoped.has(normalizeProviderId(ref)));
}

export function listPreparedSyntheticAuthProviderRefs(
  providers: readonly ProviderPlugin[],
): string[] {
  return [
    ...new Set(
      providers.flatMap((provider) =>
        typeof provider.resolveSyntheticAuth === "function"
          ? [provider.id, ...(provider.aliases ?? []), ...(provider.hookAliases ?? [])]
          : [],
      ),
    ),
  ].toSorted((left, right) => left.localeCompare(right));
}

export function resolveManifestNativeAuthRuntime(params: {
  provider: string;
  metadataSnapshot: PluginMetadataSnapshot;
}): string | undefined {
  const provider = normalizeProviderId(params.provider);
  for (const runtime of params.metadataSnapshot.owners.cliBackends.keys()) {
    if (normalizeProviderId(runtime) === provider) {
      return runtime;
    }
  }
  return params.metadataSnapshot.plugins.find((plugin) =>
    (plugin.syntheticAuthRefs ?? []).some((ref) => normalizeProviderId(ref) === provider),
  )?.cliBackends[0];
}

export function resolvePreparedSyntheticAuth(params: {
  config: OpenClawConfig;
  provider: string;
  providers: readonly ProviderPlugin[];
}): ProviderSyntheticAuthResult | undefined {
  const normalizedProvider = normalizeProviderId(params.provider);
  // Manifest row providers share ids with native-login entries (codex answers for openai) but
  // carry no auth; only an auth-bearing provider may answer for the canonical id.
  const providerPlugin = params.providers.find(
    (candidate) =>
      typeof candidate.resolveSyntheticAuth === "function" &&
      [candidate.id, ...(candidate.aliases ?? []), ...(candidate.hookAliases ?? [])].some(
        (ref) => normalizeProviderId(ref) === normalizedProvider,
      ),
  );
  return (
    providerPlugin?.resolveSyntheticAuth?.({
      config: params.config,
      provider: params.provider,
      providerConfig: Object.entries(params.config.models?.providers ?? {}).find(
        ([providerId]) => normalizeProviderId(providerId) === normalizedProvider,
      )?.[1],
    }) ?? undefined
  );
}

/** Resolves manifest synthetic-auth providers and their available native runtime owners. */
export function resolveManifestNativeHarness(params: {
  config: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  metadataSnapshot: PluginMetadataSnapshot;
  workspaceDir?: string;
  resolveRuntimes?: boolean;
}): { providerIds: string[]; runtimes: string[]; providerRefs: string[] } {
  const providers = new Set<string>();
  const runtimes = new Set<string>();
  const providerRefs = new Set<string>();
  for (const plugin of params.metadataSnapshot.plugins) {
    // Deferred plugins (activation.onStartup false) own local-server providers that only exist
    // once activated; enumerating them here would surface unauthenticated rows at startup.
    if (plugin.activation?.onStartup === false || (plugin.syntheticAuthRefs?.length ?? 0) === 0) {
      continue;
    }
    for (const ownerProvider of plugin.providers) {
      const normalized = normalizeProviderId(ownerProvider);
      if (normalized) {
        providers.add(normalized);
      }
    }
    for (const provider of plugin.syntheticAuthRefs ?? []) {
      providerRefs.add(provider);
    }
    if (params.resolveRuntimes === false) {
      continue;
    }
    for (const provider of plugin.syntheticAuthRefs ?? []) {
      const runtime = resolveProviderSyntheticAuthWithPlugin({
        provider,
        config: params.config,
        workspaceDir: params.workspaceDir,
        env: params.env,
        context: {
          config: params.config,
          provider,
          providerConfig: params.config.models?.providers?.[provider],
        },
      })?.runtime?.trim();
      if (!runtime) {
        continue;
      }
      runtimes.add(runtime);
    }
  }
  return {
    providerIds: [...providers].toSorted((left, right) => left.localeCompare(right)),
    runtimes: [...runtimes].toSorted((left, right) => left.localeCompare(right)),
    providerRefs: [...providerRefs].toSorted((left, right) => left.localeCompare(right)),
  };
}
