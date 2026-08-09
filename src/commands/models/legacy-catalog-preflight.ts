/** Upgrade guard for direct model commands that read canonical catalog state. */
import type { OpenClawConfig } from "../../config/types.openclaw.js";

/** Refuses partial model output until Doctor imports released catalog sidecars. */
export async function requireCanonicalModelCatalogState(params: {
  config: OpenClawConfig;
  agentDir: string;
  env?: NodeJS.ProcessEnv;
}): Promise<void> {
  const { detectLegacyPluginModelCatalogs, formatLegacyPluginModelCatalogCommandRefusal } =
    await import("../doctor-plugin-model-catalog-detection.js");
  const detection = await detectLegacyPluginModelCatalogs({
    cfg: params.config,
    env: params.env,
    agentDirs: [params.agentDir],
  });
  if (detection.detected.length > 0) {
    throw new Error(formatLegacyPluginModelCatalogCommandRefusal(detection.detected));
  }
}
