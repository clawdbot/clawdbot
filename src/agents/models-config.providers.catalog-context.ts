import {
  findNormalizedProviderValue,
  normalizeProviderId,
} from "@openclaw/model-catalog-core/provider-id";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import type {
  ProviderCatalogOutcome,
  ProviderCatalogResult,
} from "../plugins/provider-catalog.types.js";
import {
  normalizePluginDiscoveryResult,
  type runProviderCatalog,
} from "../plugins/provider-discovery.js";
import { matchesProviderPluginRef } from "../plugins/provider-registry-shared.js";
import type { ProviderPlugin } from "../plugins/types.js";
import { isTrustedSecretSurfaceUnavailableError } from "../secrets/runtime-degraded-state.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import type { ProviderConfig } from "./models-config.providers.secret-helpers.js";
import { resolveProviderIdForAuth } from "./provider-auth-aliases.js";

type CatalogContext = {
  config?: OpenClawConfig;
  discoveryAuthConfig?: OpenClawConfig;
  explicitProviders?: Record<string, ProviderConfig> | null;
};

export function buildPluginCatalogConfig(
  ctx: CatalogContext,
  provider: ProviderPlugin,
): OpenClawConfig {
  const providers = { ...ctx.config?.models?.providers, ...ctx.explicitProviders };
  if (Object.keys(providers).length === 0) {
    return ctx.config ?? {};
  }
  for (const [providerId, source] of Object.entries(providers)) {
    const runtime = findNormalizedProviderValue(
      ctx.discoveryAuthConfig?.models?.providers,
      providerId,
    );
    if (runtime && matchesProviderPluginRef(provider, providerId)) {
      // Keep source auth selection and other providers private; only this hook's
      // request surfaces consume the matching materialized runtime values.
      providers[providerId] = { ...source, headers: runtime.headers, request: runtime.request };
    }
  }
  return {
    ...ctx.config,
    models: {
      ...ctx.config?.models,
      providers,
    },
  };
}

export async function prepareProviderCatalogRun(
  params: Parameters<typeof runProviderCatalog>[0] & {
    agentDir: string;
    authStore: AuthProfileStore;
    isActive: () => boolean;
    timeoutMs?: number | null;
  },
): Promise<
  Parameters<typeof runProviderCatalog>[0] & {
    timeoutMs?: number | null;
    finalizeCatalogResult?: (result: ProviderCatalogResult) => ProviderCatalogResult;
  }
> {
  const { authStore, isActive, ...catalogParams } = params;
  if (
    !params.provider.auth.some((method) => method.kind === "oauth") ||
    (params.providerIds !== undefined &&
      !params.providerIds.some((providerId) =>
        matchesProviderPluginRef(params.provider, providerId),
      ))
  ) {
    return catalogParams;
  }
  // Preparation stays internal and provider-generic. The helper exits before
  // materialization unless this catalog's selected credential is expiring OAuth.
  const { prepareProviderCatalogOAuthAuth } =
    await import("./models-config.providers.discovery-auth.runtime.js");
  const failedProfileIds = new Set<string>();
  const reportedOutcomes: ProviderCatalogOutcome[] = [];
  return {
    ...catalogParams,
    reportCatalogOutcome: (outcome) => {
      reportedOutcomes.push({ ...outcome });
      params.reportCatalogOutcome?.(outcome);
    },
    resolveProviderAuth: await prepareProviderCatalogOAuthAuth(
      {
        agentDir: params.agentDir,
        authStore,
        env: params.env,
        provider: params.provider.id,
        resolveProviderAuth: params.resolveProviderAuth,
        isActive,
        onPreparationFailure: (profileIds) => {
          for (const profileId of profileIds) {
            failedProfileIds.add(profileId);
          }
        },
      },
      params.config,
    ),
    finalizeCatalogResult: (result) => {
      if (failedProfileIds.size === 0) {
        return result;
      }
      const providers = normalizePluginDiscoveryResult({ provider: params.provider, result });
      const providersWithOutcomes = new Set(
        reportedOutcomes.map((outcome) => normalizeProviderId(outcome.provider)),
      );
      const aliasContext = { config: params.config, env: params.env };
      const authProvider = resolveProviderIdForAuth(params.provider.id, aliasContext);
      for (const provider of params.providerIds ?? [params.provider.id]) {
        const normalized = normalizeProviderId(provider);
        if (
          resolveProviderIdForAuth(provider, aliasContext) !== authProvider ||
          providers[normalized] ||
          providersWithOutcomes.has(normalized)
        ) {
          continue;
        }
        // A plugin's selected result wins; only otherwise-unreported exhaustion
        // carries every attempted profile into compatible inventory retention.
        for (const profileId of failedProfileIds) {
          const outcome: ProviderCatalogOutcome = { provider, profileId, status: "unavailable" };
          reportedOutcomes.push(outcome);
          params.reportCatalogOutcome?.(outcome);
        }
      }
      // Carry the accepted snapshot forward without evaluating plugin getters again.
      return result ? { providers, outcomes: reportedOutcomes } : result;
    },
  };
}

export async function reportProviderCatalogSecretFailure(
  error: unknown,
  params: {
    provider: { id: string };
    providerIds?: readonly string[];
    reportCatalogOutcome?: (outcome: ProviderCatalogOutcome) => void;
  },
): Promise<boolean> {
  if (!isTrustedSecretSurfaceUnavailableError(error)) {
    return false;
  }
  const { resolveUnavailableDiscoveryAuthProfileId } =
    await import("./models-config.providers.discovery-auth.runtime.js");
  const profileId = resolveUnavailableDiscoveryAuthProfileId(error);
  for (const provider of params.providerIds ?? [params.provider.id]) {
    params.reportCatalogOutcome?.({
      provider,
      ...(profileId ? { profileId } : {}),
      status: "unavailable",
    });
  }
  return true;
}
