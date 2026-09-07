/** Synthetic-auth provider ref selection and prepared-catalog resolution for model-runtime builds. */
import { normalizeProviderId } from "@openclaw/model-catalog-core/provider-id";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { prepareSyntheticAuthWithProvider } from "../plugins/provider-synthetic-auth.js";
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
        provider.resolveSyntheticAuth || provider.prepareSyntheticAuth
          ? [provider.id, ...(provider.aliases ?? []), ...(provider.hookAliases ?? [])]
          : [],
      ),
    ),
  ].toSorted((left, right) => left.localeCompare(right));
}

export async function prepareSyntheticAuth(params: {
  config: OpenClawConfig;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
  workspaceDir?: string;
  provider: string;
  providers: readonly ProviderPlugin[];
}): Promise<{ apiKey?: string } | undefined> {
  const normalizedProvider = normalizeProviderId(params.provider);
  const providerPlugin = params.providers.find((candidate) =>
    [candidate.id, ...(candidate.aliases ?? []), ...(candidate.hookAliases ?? [])].some(
      (ref) => normalizeProviderId(ref) === normalizedProvider,
    ),
  );
  const context = {
    config: params.config,
    provider: params.provider,
    providerConfig: Object.entries(params.config.models?.providers ?? {}).find(
      ([providerId]) => normalizeProviderId(providerId) === normalizedProvider,
    )?.[1],
  };
  return providerPlugin
    ? await prepareSyntheticAuthWithProvider(providerPlugin, context, params)
    : undefined;
}
