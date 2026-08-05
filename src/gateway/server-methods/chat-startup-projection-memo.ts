// Config-keyed chat.startup projections shared across session switches.
import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import { hashRuntimeConfigValue } from "../../config/runtime-snapshot.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";
import type { GatewayModelCatalogSnapshot } from "../server-model-catalog.types.js";
import { listAgentsForGateway } from "../session-utils.js";
import type { GatewayRequestContext } from "./types.js";

type ChatStartupProjectionMemo = {
  config: OpenClawConfig;
  catalogEntries: ModelCatalogEntry[];
  catalogRouteVariants: ModelCatalogEntry[];
  agentsListByKey: Map<string, ReturnType<typeof listAgentsForGateway>>;
};

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
  };
  chatStartupProjectionMemoByContext.set(context, next);
  return next;
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
