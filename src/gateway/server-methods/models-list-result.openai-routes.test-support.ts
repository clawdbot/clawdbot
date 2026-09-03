import type { PreparedProviderAuth } from "../../agents/agent-auth-credential-modes.js";
import { loadAuthProfileStoreWithoutExternalProfiles } from "../../agents/auth-profiles.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { loadManifestMetadataSnapshot } from "../../plugins/manifest-contract-eligibility.js";
import type { PluginMetadataSnapshot } from "../../plugins/plugin-metadata-snapshot.types.js";
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
  agentDir?: string;
  workspaceDir?: string;
  preparedOnly?: boolean;
  catalog: ModelCatalogEntry[];
  catalogLoadDelayMs?: number;
  preparedCatalog?: ModelCatalogEntry[];
  publishedCatalog?: ModelCatalogEntry[];
  refresh?: boolean;
  staticEntries?: ModelCatalogEntry[];
  cfg?: OpenClawConfig;
  discoveryModes?: Record<string, "refreshable" | "runtime" | "static">;
  catalogComplete?: boolean;
  preparedProviderAuth?: PreparedProviderAuth;
  metadataSnapshot?: PluginMetadataSnapshot;
  view?: "all" | "configured" | "provider-config" | "default";
}) {
  const agentId = params.agentId ?? "main";
  const config = params.cfg ?? ({} as OpenClawConfig);
  const createCatalogSnapshot = (entries: ModelCatalogEntry[]) =>
    ({
      agentId,
      agentDir: params.agentDir ?? "/tmp/models-list-openai-agent",
      catalogComplete: params.catalogComplete ?? false,
      workspaceDir: params.workspaceDir ?? "/tmp/models-list-openai-workspace",
      config,
      providerAuth: params.preparedProviderAuth ?? {},
      oauthRefreshProviderIds: [],
      authStore: loadAuthProfileStoreWithoutExternalProfiles(
        params.agentDir ?? "/tmp/models-list-openai-agent",
        {
          allowKeychainPrompt: false,
        },
      ),
      metadataSnapshot:
        params.metadataSnapshot ?? loadManifestMetadataSnapshot({ config, env: process.env }),
      entries,
      routeVariants: entries,
      ...(params.staticEntries ? { staticEntries: params.staticEntries } : {}),
      authMaterializations: [],
    }) satisfies PreparedGatewayModelCatalogSnapshot;
  const loadGatewayModelCatalogSnapshot = async (loadParams?: object) => {
    if (params.catalogLoadDelayMs !== undefined) {
      await new Promise<void>((resolve) => {
        setTimeout(resolve, params.catalogLoadDelayMs);
      });
    }
    const readOnly = loadParams && "readOnly" in loadParams && loadParams.readOnly === true;
    return createCatalogSnapshot(
      readOnly && params.preparedCatalog ? params.preparedCatalog : params.catalog,
    );
  };
  registerGatewayModelCatalogPrivateAccess(loadGatewayModelCatalogSnapshot, {
    loadDeferred: loadGatewayModelCatalogSnapshot,
    readPrepared: params.publishedCatalog
      ? async () => createCatalogSnapshot(params.publishedCatalog ?? [])
      : loadGatewayModelCatalogSnapshot,
  });
  const context = {
    getRuntimeConfig: () => config,
    loadGatewayModelCatalogSnapshot,
    logGateway: { debug: () => {}, warn: () => {} },
  } as unknown as GatewayRequestContext;
  const listParams = {
    view: params.view ?? "all",
    ...(params.refresh ? { refresh: true } : {}),
    ...(params.preparedOnly ? { preparedOnly: true } : {}),
  } as const;
  if (!params.discoveryModes) {
    return await buildModelsListResult({
      source: { kind: "gateway", context },
      agentId,
      params: listParams,
    });
  }
  return await buildModelsListResult({
    source: {
      kind: "published",
      context,
      config,
      snapshot: { entries: params.catalog, routeVariants: params.catalog },
      projector: {
        metadataSnapshot: {
          index: { plugins: [] },
          manifestRegistry: { plugins: [] },
          plugins: [{ id: "test-provider", modelCatalog: { discovery: params.discoveryModes } }],
        },
        authStore: { version: 1, profiles: {} },
      } as never,
    },
    agentId,
    params: listParams,
  });
}
