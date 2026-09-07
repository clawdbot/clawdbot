// Deepinfra provider module implements model/runtime integration.
import { runLiveProviderCatalog } from "openclaw/plugin-sdk/provider-catalog-live-runtime";
import {
  buildSingleProviderApiKeyCatalog,
  type ProviderCatalogContext,
  type ProviderCatalogResult,
} from "openclaw/plugin-sdk/provider-catalog-shared";
import type { ModelProviderConfig } from "openclaw/plugin-sdk/provider-model-shared";
import { DEEPINFRA_BASE_URL } from "./media-models.js";
import {
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
  discoveryMode?: "strict";
}): Promise<ModelProviderConfig> {
  const models = await discoverDeepInfraModels({
    ...options,
    discoveryMode: options?.discoveryMode ?? "advisory",
  });
  return {
    baseUrl: DEEPINFRA_BASE_URL,
    api: "openai-completions",
    models,
  };
}

export function buildDeepInfraApiKeyCatalog(
  ctx: ProviderCatalogContext,
): Promise<ProviderCatalogResult> {
  return runLiveProviderCatalog({
    providerId: "deepinfra",
    run: () =>
      buildSingleProviderApiKeyCatalog({
        ctx,
        providerId: "deepinfra",
        buildProvider: () =>
          buildDeepInfraProvider({
            hasApiKey: true,
            discoveryMode: "strict",
            env: ctx.env,
            agentDir: ctx.agentDir,
          }),
      }),
  });
}
