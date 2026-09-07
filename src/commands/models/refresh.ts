import { ExpectedCliError } from "../../cli/failure-output.js";
import { getRuntimeConfig } from "../../config/config.js";
import { refreshRemoteModelCatalog } from "../../model-catalog/remote-refresh.js";
import { type RuntimeEnv, writeRuntimeJson } from "../../runtime.js";

export async function modelsRefreshCommand(
  options: { json?: boolean },
  runtime: RuntimeEnv,
): Promise<void> {
  const result = await refreshRemoteModelCatalog({ config: getRuntimeConfig(), force: true });
  if (result.status === "error") {
    const message = `Remote catalog refresh failed: ${result.error}`;
    throw new ExpectedCliError({ message, humanOutput: message, machineOutput: message });
  }
  if (options.json) {
    writeRuntimeJson(runtime, result, 0);
    return;
  }
  if (result.status === "disabled") {
    runtime.log("Remote catalog refresh is disabled (models.catalogRefresh.enabled=false)");
    return;
  }
  runtime.log(
    `Remote catalog refresh: ${result.status} (${result.providers} providers, ${result.models} models; generated ${new Date(result.generatedAt).toISOString()})`,
  );
  if (result.status === "updated") {
    runtime.log("A running Gateway applies the updated catalog after its next restart.");
  }
}
