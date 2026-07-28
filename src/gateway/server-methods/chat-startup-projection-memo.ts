// Config-keyed chat.startup projections shared across session switches.
import { modelCatalogBrowseRequiresFullDiscovery } from "../../agents/model-catalog-browse.js";
import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import { resolveSwarmConfig } from "../../agents/swarm-config.js";
import { hashRuntimeConfigValue } from "../../config/runtime-snapshot.js";
import type { SessionEntry } from "../../config/sessions.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import { formatErrorMessage } from "../../infra/errors.js";
import { normalizeAgentId } from "../../routing/session-key.js";
import type { GatewayModelCatalogSnapshot } from "../server-model-catalog.types.js";
import { listAgentsForGateway } from "../session-utils.js";
import type { GatewayRequestContext } from "./types.js";

type ChatMetadataResult = {
  commands?: unknown[];
  models?: unknown[];
  swarmEnabled: boolean;
};

type CatalogProjector = ReturnType<
  (typeof import("./models-list-result.js"))["createGatewayAgentModelCatalogProjector"]
>;

type ChatStartupProjectionMemo = {
  config: OpenClawConfig;
  catalogEntries: ModelCatalogEntry[];
  catalogRouteVariants: ModelCatalogEntry[];
  agentsListByKey: Map<string, ReturnType<typeof listAgentsForGateway>>;
  metadataByKey: Map<string, ChatMetadataResult>;
};

const CHAT_STARTUP_METADATA_CACHE_MAX_ENTRIES = 32;

const chatStartupProjectionMemoByContext = new WeakMap<
  GatewayRequestContext,
  ChatStartupProjectionMemo
>();

function runtimeConfigsMatch(left: OpenClawConfig, right: OpenClawConfig): boolean {
  if (left === right) {
    return true;
  }
  try {
    return hashRuntimeConfigValue(left) === hashRuntimeConfigValue(right);
  } catch {
    return false;
  }
}

function getChatStartupProjectionMemo(
  context: GatewayRequestContext,
  config: OpenClawConfig,
  modelCatalog: GatewayModelCatalogSnapshot,
): ChatStartupProjectionMemo {
  const current = chatStartupProjectionMemoByContext.get(context);
  if (
    current &&
    current.catalogEntries === modelCatalog.entries &&
    current.catalogRouteVariants === modelCatalog.routeVariants &&
    runtimeConfigsMatch(current.config, config)
  ) {
    return current;
  }
  // Config and prepared-catalog arrays are stable until their owners publish a new generation.
  // Replace the context-local memo when either changes so auth/catalog refreshes cannot go stale.
  const next = {
    config,
    catalogEntries: modelCatalog.entries,
    catalogRouteVariants: modelCatalog.routeVariants,
    agentsListByKey: new Map(),
    metadataByKey: new Map(),
  };
  chatStartupProjectionMemoByContext.set(context, next);
  return next;
}

function setChatStartupMetadataMemo(
  memo: ChatStartupProjectionMemo,
  key: string,
  value: ChatMetadataResult,
): void {
  memo.metadataByKey.delete(key);
  memo.metadataByKey.set(key, value);
  if (memo.metadataByKey.size <= CHAT_STARTUP_METADATA_CACHE_MAX_ENTRIES) {
    return;
  }
  const oldestKey = memo.metadataByKey.keys().next().value;
  if (oldestKey) {
    memo.metadataByKey.delete(oldestKey);
  }
}

function resolveChatStartupMetadataMemoKey(params: {
  agentId: string;
  sessionEntry: SessionEntry | undefined;
}): string {
  return [
    normalizeAgentId(params.agentId),
    params.sessionEntry?.authProfileOverride?.trim() ?? "",
    params.sessionEntry?.authProfileOverrideSource ?? "",
    params.sessionEntry?.authProfileOverrideCompactionCount ?? "",
  ].join("\0");
}

async function buildChatStartupMetadataResult(params: {
  cfg: OpenClawConfig;
  context: GatewayRequestContext;
  agentId: string;
  modelCatalog: GatewayModelCatalogSnapshot | undefined;
  catalogProjector?: CatalogProjector;
}): Promise<ChatMetadataResult | undefined> {
  if (!params.modelCatalog) {
    return undefined;
  }
  if (modelCatalogBrowseRequiresFullDiscovery({ cfg: params.cfg, view: "configured" })) {
    return undefined;
  }
  try {
    const { buildModelsListResult } = await import("./models-list-result.js");
    const currentConfig = params.context.getRuntimeConfig();
    if (
      params.modelCatalog.agentId !== params.agentId ||
      !runtimeConfigsMatch(currentConfig, params.cfg)
    ) {
      return undefined;
    }
    const models = await buildModelsListResult({
      context: params.context,
      agentId: params.agentId,
      params: { view: "configured" },
      preloadedCatalog: {
        agentId: params.agentId,
        config: currentConfig,
        snapshot: params.modelCatalog,
      },
      preloadedOnly: true,
      ...(params.catalogProjector ? { catalogProjector: params.catalogProjector } : {}),
    });
    return {
      ...models,
      swarmEnabled: resolveSwarmConfig(params.cfg, params.agentId).enabled,
    };
  } catch (err) {
    params.context.logGateway.debug(
      `chat.startup continuing without metadata: ${formatErrorMessage(err)}`,
    );
    return undefined;
  }
}

export async function buildMemoizedChatStartupMetadataResult(params: {
  cfg: OpenClawConfig;
  context: GatewayRequestContext;
  agentId: string;
  modelCatalog: GatewayModelCatalogSnapshot;
  sessionEntry: SessionEntry | undefined;
  catalogProjector?: CatalogProjector;
}): Promise<ChatMetadataResult | undefined> {
  if (!runtimeConfigsMatch(params.context.getRuntimeConfig(), params.cfg)) {
    chatStartupProjectionMemoByContext.delete(params.context);
    return undefined;
  }
  const memo = getChatStartupProjectionMemo(params.context, params.cfg, params.modelCatalog);
  const key = resolveChatStartupMetadataMemoKey(params);
  const cached = memo.metadataByKey.get(key);
  if (cached) {
    memo.metadataByKey.delete(key);
    memo.metadataByKey.set(key, cached);
    return cached;
  }
  const result = await buildChatStartupMetadataResult(params);
  if (result && runtimeConfigsMatch(params.context.getRuntimeConfig(), params.cfg)) {
    setChatStartupMetadataMemo(memo, key, result);
  }
  return result;
}

export function listMemoizedChatStartupAgents(params: {
  cfg: OpenClawConfig;
  context: GatewayRequestContext;
  includeSystem: boolean;
  catalogSnapshot: GatewayModelCatalogSnapshot;
  modelCatalog: ModelCatalogEntry[];
  modelCatalogByAgentId: ReadonlyMap<string, ModelCatalogEntry[]>;
}): ReturnType<typeof listAgentsForGateway> {
  const buildAgentsList = () =>
    listAgentsForGateway(params.cfg, params.modelCatalog, {
      modelCatalogByAgentId: params.modelCatalogByAgentId,
      includeSystem: params.includeSystem,
    });
  if (
    !runtimeConfigsMatch(params.context.getRuntimeConfig(), params.cfg) ||
    !runtimeConfigsMatch(params.catalogSnapshot.config, params.cfg)
  ) {
    return buildAgentsList();
  }
  const memo = getChatStartupProjectionMemo(params.context, params.cfg, params.catalogSnapshot);
  const key = params.includeSystem ? "include-system" : "agents-only";
  const cached = memo.agentsListByKey.get(key);
  if (cached) {
    return cached;
  }
  const agentsList = buildAgentsList();
  memo.agentsListByKey.set(key, agentsList);
  return agentsList;
}
