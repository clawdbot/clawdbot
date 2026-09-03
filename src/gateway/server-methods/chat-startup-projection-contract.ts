import type { ModelCatalogEntry } from "../../agents/model-catalog.types.js";
import type { ChatMetadataResult, ChatMetadataSessionEntry } from "./chat-metadata-contract.js";

export type ChatStartupProjectionReadParams = {
  agentId: string;
  sessionKey?: string;
  sessionEntry?: ChatMetadataSessionEntry;
  // Ready reads return settled catalogs only; startup also reads current model availability.
  readPolicy?: "current" | "ready";
};

export type ChatStartupProjectionResult = {
  metadata?: ChatMetadataResult;
  sessionModelCatalog: ModelCatalogEntry[];
  defaultModelCatalog: ModelCatalogEntry[];
};
