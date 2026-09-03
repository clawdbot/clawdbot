import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { PluginMetadataSnapshot } from "../plugins/plugin-metadata-snapshot.js";
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
