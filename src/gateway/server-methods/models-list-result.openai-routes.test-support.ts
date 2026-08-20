import { loadAuthProfileStoreWithoutExternalProfiles } from "../../agents/auth-profiles.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import type { createOpenAIModelRoutesResolver } from "../../agents/openai-model-routes.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { loadManifestMetadataSnapshot } from "../../plugins/manifest-contract-eligibility.js";
import {
  type PreparedGatewayModelCatalogSnapshot,
  registerGatewayModelCatalogPrivateAccess,
} from "../server-model-catalog-auth.js";
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

export function registerTestCatalogAccess(
  context: GatewayRequestContext,
  readPrepared?: () => Promise<PreparedGatewayModelCatalogSnapshot | undefined>,
): void {
  registerGatewayModelCatalogPrivateAccess(context.loadGatewayModelCatalogSnapshot, {
    loadDeferred: async (params) =>
      (await context.loadGatewayModelCatalogSnapshot(
        params,
      )) as PreparedGatewayModelCatalogSnapshot,
    readPrepared: readPrepared ?? (async () => undefined),
  });
}

export async function listModels(params: {
  agentId?: string;
  catalog: ModelCatalogEntry[];
  staticEntries?: ModelCatalogEntry[];
  cfg?: OpenClawConfig;
  discoveryModes?: Record<string, "refreshable" | "runtime" | "static">;
  routeResolverFactory?: typeof createOpenAIModelRoutesResolver;
  view?: "all" | "configured" | "provider-config" | "default";
}) {
  const agentId = params.agentId ?? "main";
  const config = params.cfg ?? ({} as OpenClawConfig);
  const loadGatewayModelCatalogSnapshot = async () =>
    ({
      agentId,
      agentDir: "/tmp/models-list-openai-agent",
      catalogComplete: false,
      workspaceDir: "/tmp/models-list-openai-workspace",
      config,
      authModes: {},
      authStore: loadAuthProfileStoreWithoutExternalProfiles("/tmp/models-list-openai-agent", {
        allowKeychainPrompt: false,
      }),
      metadataSnapshot: loadManifestMetadataSnapshot({ config, env: process.env }),
      entries: params.catalog,
      routeVariants: params.catalog,
      ...(params.staticEntries ? { staticEntries: params.staticEntries } : {}),
      authMaterializations: [],
    }) satisfies PreparedGatewayModelCatalogSnapshot;
  registerGatewayModelCatalogPrivateAccess(loadGatewayModelCatalogSnapshot, {
    loadDeferred: loadGatewayModelCatalogSnapshot,
    readPrepared: loadGatewayModelCatalogSnapshot,
  });
  const context = {
    getRuntimeConfig: () => config,
    loadGatewayModelCatalogSnapshot,
    logGateway: { debug: () => {} },
  } as unknown as GatewayRequestContext;
  return await buildModelsListResult({
    context,
    agentId,
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
