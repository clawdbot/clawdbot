import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ProviderCatalogOutcome } from "../plugins/provider-catalog.types.js";
import type { runProviderCatalog } from "../plugins/provider-discovery.js";
import { matchesProviderPluginRef } from "../plugins/provider-registry-shared.js";
import { isTrustedSecretSurfaceUnavailableError } from "../secrets/runtime-degraded-state.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import type { ProviderConfig } from "./models-config.providers.secret-helpers.js";

type CatalogContext = {
  config?: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  explicitProviders?: Record<string, ProviderConfig> | null;
};

export function buildPluginCatalogConfig(ctx: CatalogContext): OpenClawConfig {
  if (!ctx.explicitProviders || Object.keys(ctx.explicitProviders).length === 0) {
    return ctx.config ?? {};
  }
  return {
    ...ctx.config,
    models: {
      ...ctx.config?.models,
      providers: {
        ...ctx.config?.models?.providers,
        ...ctx.explicitProviders,
      },
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
): Promise<Parameters<typeof runProviderCatalog>[0] & { timeoutMs?: number | null }> {
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
  return {
    ...catalogParams,
    resolveProviderAuth: await prepareProviderCatalogOAuthAuth(
      {
        agentDir: params.agentDir,
        authStore,
        provider: params.provider.id,
        resolveProviderAuth: params.resolveProviderAuth,
        isActive,
      },
      params.config,
    ),
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
