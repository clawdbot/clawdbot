import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-entry-contract";

type FeishuSubagentHooksModule = typeof import("./src/subagent-hooks.js");

let feishuSubagentHooksPromise: Promise<FeishuSubagentHooksModule> | null = null;

function loadFeishuSubagentHooksModule() {
  feishuSubagentHooksPromise ??= import("./src/subagent-hooks.js");
  return feishuSubagentHooksPromise;
}

export function registerFeishuSubagentHooks(api: OpenClawPluginApi): void {
  api.on("subagent_spawning", async (event, ctx) => {
    const { handleFeishuSubagentSpawning } = await loadFeishuSubagentHooksModule();
    return await handleFeishuSubagentSpawning(event, ctx);
  });
  api.on("subagent_delivery_target", async (event) => {
    const { handleFeishuSubagentDeliveryTarget } = await loadFeishuSubagentHooksModule();
    return handleFeishuSubagentDeliveryTarget(event);
  });
  api.on("subagent_ended", async (event) => {
    const { handleFeishuSubagentEnded } = await loadFeishuSubagentHooksModule();
    handleFeishuSubagentEnded(event);
  });
}

export {
  handleFeishuSubagentDeliveryTarget,
  handleFeishuSubagentEnded,
  handleFeishuSubagentSpawning,
} from "./src/subagent-hooks.js";
