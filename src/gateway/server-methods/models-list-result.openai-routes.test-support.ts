import { loadAuthProfileStoreWithoutExternalProfiles } from "../../agents/auth-profiles.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import type { createOpenAIModelRoutesResolver } from "../../agents/openai-model-routes.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { loadManifestMetadataSnapshot } from "../../plugins/manifest-contract-eligibility.js";
import { buildModelsListResult } from "./models-list-result.js";
import type { GatewayRequestContext } from "./types.js";

export const WITHOUT_OPENAI_ENV_AUTH = {
  CODEX_API_KEY: undefined,
  CODEX_HOME: "/__openclaw_models_list_test__/codex",
  OPENAI_API_KEY: undefined,
  OPENAI_BASE_URL: undefined,
  OPENAI_OAUTH_TOKEN: undefined,
  CHATGPT_OAUTH_TOKEN: undefined,
} as const;

export function catalogEntry(id: string, api: ModelCatalogEntry["api"]): ModelCatalogEntry {
  return { id, name: id, provider: "openai", api };
}

export function providerCatalogEntry(provider: string, id: string): ModelCatalogEntry {
  return { ...catalogEntry(id, "openai-completions"), provider };
}

export async function listModels(params: {
  catalog: ModelCatalogEntry[];
  cfg?: OpenClawConfig;
  discoveryModes?: Record<string, "refreshable" | "runtime" | "static">;
  routeResolverFactory?: typeof createOpenAIModelRoutesResolver;
  view?: "all" | "configured" | "provider-config" | "default";
}) {
  const config = params.cfg ?? ({} as OpenClawConfig);
  const context = {
    getRuntimeConfig: () => config,
    loadGatewayModelCatalogSnapshot: async () => ({
      agentId: "main",
      agentDir: "/tmp/models-list-openai-agent",
      config,
      authStore: loadAuthProfileStoreWithoutExternalProfiles("/tmp/models-list-openai-agent", {
        allowKeychainPrompt: false,
      }),
      metadataSnapshot: loadManifestMetadataSnapshot({ config, env: process.env }),
      entries: params.catalog,
      routeVariants: params.catalog,
    }),
    logGateway: { debug: () => {} },
  } as unknown as GatewayRequestContext;
  return await buildModelsListResult({
    context,
    params: { view: params.view ?? "all" },
    ...(params.discoveryModes
      ? {
          preloadedCatalog: {
            agentId: "main",
            config,
            snapshot: { entries: params.catalog, routeVariants: params.catalog },
          },
          catalogProjector: {
            metadataSnapshot: {
              index: { plugins: [] },
              manifestRegistry: { plugins: [] },
              plugins: [
                { id: "test-provider", modelCatalog: { discovery: params.discoveryModes } },
              ],
            },
            authStore: { version: 1, profiles: {} },
          } as never,
        }
      : {}),
    ...(params.routeResolverFactory ? { routeResolverFactory: params.routeResolverFactory } : {}),
  });
}
