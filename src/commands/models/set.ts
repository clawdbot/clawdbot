import { logConfigUpdated } from "../../config/logging.js";
import { resolveAgentModelPrimaryValue } from "../../config/model-input.js";
import type { RuntimeEnv } from "../../runtime.js";
import { repairCodexRuntimePluginInstallForModelSelection } from "../codex-runtime-plugin-install.js";
import { applyDefaultModelPrimaryUpdate, updateConfig } from "./shared.js";

export async function modelsSetCommand(modelRaw: string, runtime: RuntimeEnv) {
  const updated = await updateConfig((cfg) => {
    return applyDefaultModelPrimaryUpdate({ cfg, modelRaw, field: "model" });
  });
  const repaired = await repairCodexRuntimePluginInstallForModelSelection({
    cfg: updated,
    model: resolveAgentModelPrimaryValue(updated.agents?.defaults?.model) ?? modelRaw,
  });
  for (const warning of repaired.warnings) {
    runtime.error?.(warning);
  }

  logConfigUpdated(runtime);
  runtime.log(
    `Default model: ${resolveAgentModelPrimaryValue(updated.agents?.defaults?.model) ?? modelRaw}`,
  );
}
