import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import type { ChatMetadataResult, ChatMetadataSessionEntry } from "./chat-metadata-contract.js";

export type ChatStartupProjectionReadParams = {
  agentId: string;
  sessionEntry?: ChatMetadataSessionEntry;
  // History may use settled facts only; startup retains its current-generation wait.
  readPolicy?: "current" | "ready";
};

export type ChatStartupProjectionResult = {
  metadata: ChatMetadataResult;
  sessionModelCatalog: ModelCatalogEntry[];
  defaultModelCatalog: ModelCatalogEntry[];
};
