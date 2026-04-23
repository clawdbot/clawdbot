import type { ProviderCatalogContext } from "openclaw/plugin-sdk/provider-catalog-shared";
import type { ProviderPlugin } from "openclaw/plugin-sdk/provider-model-shared";
import {
  buildCodexProviderConfig,
  CODEX_APP_SERVER_AUTH_MARKER,
  CODEX_PROVIDER_ID,
  FALLBACK_CODEX_MODELS,
} from "./provider-catalog.js";

function resolveCodexPluginConfig(ctx: ProviderCatalogContext): unknown {
  return (ctx.config.plugins?.entries as Record<string, { config?: unknown } | undefined>)?.codex
    ?.config;
}

async function runCodexCatalog(ctx: ProviderCatalogContext) {
  const { buildCodexProviderCatalog } = await import("./provider.js");
  return await buildCodexProviderCatalog({
    env: ctx.env,
    pluginConfig: resolveCodexPluginConfig(ctx),
  });
}

export const codexProviderDiscovery: ProviderPlugin = {
  id: CODEX_PROVIDER_ID,
  label: "Codex",
  docsPath: "/providers/models",
  auth: [],
  catalog: {
    order: "late",
    run: runCodexCatalog,
  },
  staticCatalog: {
    order: "late",
    run: async () => ({
      provider: buildCodexProviderConfig(FALLBACK_CODEX_MODELS),
    }),
  },
  resolveSyntheticAuth: () => ({
    apiKey: CODEX_APP_SERVER_AUTH_MARKER,
    source: "codex-app-server",
    mode: "token",
  }),
};

export default codexProviderDiscovery;
