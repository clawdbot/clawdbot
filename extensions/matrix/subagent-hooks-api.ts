// Matrix API module exposes the plugin public contract.
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-entry-contract";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";

const loadMatrixSubagentHooksModule = createLazyRuntimeModule(
  () => import("./src/matrix/subagent-hooks.js"),
);

export function registerMatrixSubagentHooks(api: OpenClawPluginApi): void {
  api.on("subagent_ended", async (event) => {
    const { handleMatrixSubagentEnded } = await loadMatrixSubagentHooksModule();
    await handleMatrixSubagentEnded(event);
  });
  api.on("subagent_delivery_target", async (event) => {
    const { handleMatrixSubagentDeliveryTarget } = await loadMatrixSubagentHooksModule();
    return handleMatrixSubagentDeliveryTarget(event);
  });
}
