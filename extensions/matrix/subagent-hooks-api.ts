import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-entry-contract";

type MatrixSubagentHooksModule = typeof import("./src/matrix/subagent-hooks.js");

let matrixSubagentHooksPromise: Promise<MatrixSubagentHooksModule> | null = null;

function loadMatrixSubagentHooksModule() {
  matrixSubagentHooksPromise ??= import("./src/matrix/subagent-hooks.js");
  return matrixSubagentHooksPromise;
}

export function registerMatrixSubagentHooks(api: OpenClawPluginApi): void {
  api.on("subagent_spawning", async (event) => {
    const { handleMatrixSubagentSpawning } = await loadMatrixSubagentHooksModule();
    return await handleMatrixSubagentSpawning(api, event);
  });
  api.on("subagent_ended", async (event) => {
    const { handleMatrixSubagentEnded } = await loadMatrixSubagentHooksModule();
    await handleMatrixSubagentEnded(event);
  });
  api.on("subagent_delivery_target", async (event) => {
    const { handleMatrixSubagentDeliveryTarget } = await loadMatrixSubagentHooksModule();
    return handleMatrixSubagentDeliveryTarget(event);
  });
}

export {
  handleMatrixSubagentDeliveryTarget,
  handleMatrixSubagentEnded,
  handleMatrixSubagentSpawning,
} from "./src/matrix/subagent-hooks.js";
