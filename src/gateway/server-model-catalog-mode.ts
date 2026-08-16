import { listAgentIds } from "../agents/agent-scope.js";
import { modelCatalogBrowseRequiresFullDiscovery } from "../agents/model-catalog-browse.js";
import type { OpenClawConfig } from "../config/types.openclaw.js";

export function resolveGatewayModelRuntimeCatalogModeOptions(
  cfg: OpenClawConfig,
):
  | { catalogMode: "live" | "static" }
  | { catalogModeForAgent: (agentId: string | undefined) => "live" | "static" } {
  const catalogModeForAgent = (agentId: string | undefined) =>
    modelCatalogBrowseRequiresFullDiscovery({ cfg, agentId, view: "default" }) ? "live" : "static";
  const catalogModes = new Set(listAgentIds(cfg).map(catalogModeForAgent));
  return catalogModes.size <= 1
    ? { catalogMode: [...catalogModes][0] ?? "static" }
    : { catalogModeForAgent };
}
