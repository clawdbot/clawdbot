import { buildProviderConfigModelCatalogForBrowse } from "../../agents/model-catalog-browse.js";
import type { ModelCatalogBrowseView } from "../../agents/model-catalog-browse.js";
import { getRuntimeConfigSourceSnapshot } from "../../config/config.js";
import type { OpenClawConfig } from "../../config/types.openclaw.js";

export function resolveConfiguredCatalogMode(params: {
  cfg: OpenClawConfig;
  view: ModelCatalogBrowseView;
  workspaceDir: string;
}): "replace" | undefined {
  const sourceConfig = getRuntimeConfigSourceSnapshot() ?? params.cfg;
  return params.view === "configured" &&
    sourceConfig.models?.mode === "replace" &&
    buildProviderConfigModelCatalogForBrowse({
      cfg: sourceConfig,
      workspaceDir: params.workspaceDir,
    }).length > 0
    ? "replace"
    : undefined;
}
