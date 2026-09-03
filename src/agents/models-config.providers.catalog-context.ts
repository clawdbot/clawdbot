import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
import type { runProviderCatalog } from "../plugins/provider-discovery.js";
import { matchesProviderPluginRef } from "../plugins/provider-registry-shared.js";
import type { AuthProfileStore } from "./auth-profiles/types.js";
import type { ProviderConfig } from "./models-config.providers.secret-helpers.js";
import { resolveProviderIdForAuth } from "./provider-auth-aliases.js";

type CatalogContext = {
  config?: OpenClawConfig;
  env: NodeJS.ProcessEnv;
  explicitProviders?: Record<string, ProviderConfig> | null;
  workspaceDir?: string;
  pluginMetadataSnapshot?: Pick<PluginMetadataSnapshot, "manifestRegistry" | "owners">;
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

export function createProviderCatalogAuthIdResolver(
  ctx: Omit<CatalogContext, "explicitProviders">,
): (provider: string) => string {
  const metadataSnapshot = ctx.pluginMetadataSnapshot
    ? {
        plugins: ctx.pluginMetadataSnapshot.manifestRegistry.plugins,
        owners: {
          providerAuthAliases: ctx.pluginMetadataSnapshot.owners.providerAuthAliases,
        },
      }
    : undefined;
  return (provider) =>
    resolveProviderIdForAuth(provider, {
      config: ctx.config,
      workspaceDir: ctx.workspaceDir,
      env: ctx.env,
      ...(metadataSnapshot ? { metadataSnapshot } : {}),
    });
}

export async function prepareProviderCatalogRun(
  params: Parameters<typeof runProviderCatalog>[0] & {
    agentDir: string;
    authStore: AuthProfileStore;
    timeoutMs?: number | null;
  },
): Promise<Parameters<typeof runProviderCatalog>[0] & { timeoutMs?: number | null }> {
  const { authStore, ...catalogParams } = params;
  if (
    params.provider.catalog?.prepareAuthProfiles !== "oauth" ||
    (params.providerIds !== undefined &&
      !params.providerIds.some((providerId) =>
        matchesProviderPluginRef(params.provider, providerId),
      ))
  ) {
    return catalogParams;
  }
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
      },
      params.config,
    ),
  };
}
