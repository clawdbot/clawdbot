import type { ModelCatalogSnapshot } from "../agents/model-catalog.types.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

export type GatewayModelCatalogOwnerSnapshot = {
  agentId?: string;
  agentDir: string;
  workspaceDir?: string;
  config: OpenClawConfig;
  modelCatalog: ModelCatalogSnapshot;
};

export type GatewayModelCatalogSnapshot = ModelCatalogSnapshot &
  Omit<GatewayModelCatalogOwnerSnapshot, "modelCatalog">;
