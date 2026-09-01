/** Command for setting the default image model. */
import { logConfigUpdated } from "../../config/logging.js";
import { resolveAgentModelPrimaryValue } from "../../config/model-input.js";
import type { RuntimeEnv } from "../../runtime.js";
import { updateDefaultModelPrimaryConfig } from "./shared.js";

/** Sets agents.defaults.imageModel.primary after resolving aliases/catalog provider aliases. */
export async function modelsSetImageCommand(modelRaw: string, runtime: RuntimeEnv) {
  const { updated, warning } = await updateDefaultModelPrimaryConfig({
    modelRaw,
    field: "imageModel",
  });
  if (warning) {
    runtime.error?.(warning);
  }

  logConfigUpdated(runtime);
  runtime.log(
    `Image model: ${resolveAgentModelPrimaryValue(updated.agents?.defaults?.imageModel) ?? modelRaw}`,
  );
}
