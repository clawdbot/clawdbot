import type { ProviderCatalogContext } from "openclaw/plugin-sdk/provider-catalog-shared";
import {
  OLLAMA_PROVIDER_ID,
  resolveOllamaDiscoveryResult,
  type OllamaPluginConfig,
} from "./src/discovery-shared.js";
import { buildOllamaProvider } from "./src/provider-models.js";

type OllamaProviderPlugin = {
  id: string;
  label: string;
  docsPath: string;
  envVars: string[];
  auth: [];
  discovery: {
    order: "late";
    run: (ctx: ProviderCatalogContext) => ReturnType<typeof runOllamaDiscovery>;
  };
};

function resolveOllamaPluginConfig(ctx: ProviderCatalogContext): OllamaPluginConfig {
  const entries = (ctx.config.plugins?.entries ?? {}) as Record<
    string,
    { config?: OllamaPluginConfig }
  >;
  return entries.ollama?.config ?? {};
}

async function runOllamaDiscovery(ctx: ProviderCatalogContext) {
  return await resolveOllamaDiscoveryResult({
    ctx,
    pluginConfig: resolveOllamaPluginConfig(ctx),
    buildProvider: buildOllamaProvider,
  });
}

export const ollamaProviderDiscovery: OllamaProviderPlugin = {
  id: OLLAMA_PROVIDER_ID,
  label: "Ollama",
  docsPath: "/providers/ollama",
  envVars: ["OLLAMA_API_KEY"],
  auth: [],
  discovery: {
    order: "late",
    run: runOllamaDiscovery,
  },
};

export default ollamaProviderDiscovery;
