import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import type { SessionScope } from "../../config/types.base.js";
import type { GatewayAgentRow } from "../../shared/session-types.js";
import type { ChatMetadataResult, ChatMetadataSessionEntry } from "./chat-metadata-contract.js";

export type ChatStartupProjectionReadParams = {
  agentId: string;
  sessionEntry?: ChatMetadataSessionEntry;
  includeSystem: boolean;
};

export type ChatStartupProjectionResult = {
  metadata: ChatMetadataResult;
  sessionModelCatalog: ModelCatalogEntry[];
  defaultModelCatalog: ModelCatalogEntry[];
  agentsList: {
    defaultId: string;
    mainKey: string;
    scope: SessionScope;
    agents: GatewayAgentRow[];
  };
};
