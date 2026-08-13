import type { OpenClawConfig } from "../config/types.openclaw.js";
import type { ModelCatalogSnapshot } from "./model-catalog.types.js";

export type PublishedModelCatalogOwnerCandidate = Readonly<{
  agentId?: string;
  agentDir: string;
  workspaceDir?: string;
  config: OpenClawConfig;
  modelCatalog: ModelCatalogSnapshot;
}>;

export type ResolvedPublishedModelCatalogOwner = Readonly<{
  agentId: string;
  agentDir: string;
  workspaceDir: string;
  config: OpenClawConfig;
  modelCatalog: ModelCatalogSnapshot;
}>;
