import {
  buildSingleProviderApiKeyCatalog,
  type ProviderCatalogContext,
  type ProviderCatalogResult,
} from "openclaw/plugin-sdk/provider-catalog-shared";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import {
  DEEPINFRA_BASE_URL,
  DEEPINFRA_MODEL_CATALOG,
  buildDeepInfraModelDefinition,
  discoverDeepInfraModels,
} from "./provider-models.js";

export function buildStaticDeepInfraProvider(): ModelProviderConfig {
  return {
    baseUrl: DEEPINFRA_BASE_URL,
    api: "openai-completions",
    models: DEEPINFRA_MODEL_CATALOG.map(buildDeepInfraModelDefinition),
  };
}

export async function buildDeepInfraProvider(options?: {
  hasApiKey?: boolean;
  env?: NodeJS.ProcessEnv;
  agentDir?: string;
}): Promise<ModelProviderConfig> {
  const models = await discoverDeepInfraModels(options);
  return {
    baseUrl: DEEPINFRA_BASE_URL,
    api: "openai-completions",
    models,
  };
}

export function buildDeepInfraApiKeyCatalog(
  ctx: ProviderCatalogContext,
): Promise<ProviderCatalogResult> {
  return buildSingleProviderApiKeyCatalog({
    ctx,
    providerId: "deepinfra",
    // The shared API-key helper already resolved env/profile credentials.
    // Pass that fact into discovery so profile-only setups get the live catalog.
    buildProvider: () =>
      buildDeepInfraProvider({
        hasApiKey: true,
        env: ctx.env,
        agentDir: ctx.agentDir,
      }),
  });
}
