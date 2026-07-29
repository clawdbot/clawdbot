// Discord API module exposes the plugin public contract.
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-entry-contract";
import { createLazyRuntimeModule } from "openclaw/plugin-sdk/lazy-runtime";

const loadDiscordSubagentHooksModule = createLazyRuntimeModule(
  () => import("./src/subagent-hooks.js"),
);
const loadDiscordSubagentProgressModule = createLazyRuntimeModule(
  () => import("./src/subagent-progress.js"),
);

// Subagent hooks live behind a dedicated barrel so the bundled entry can
// register one stable hook wiring path while keeping the handler module lazy.
export function registerDiscordSubagentHooks(api: OpenClawPluginApi): void {
  api.on("gateway_start", async () => {
    const { recoverDiscordSubagentProgress } = await loadDiscordSubagentProgressModule();
    await recoverDiscordSubagentProgress(api);
  });
  api.on("subagent_progress", async (event) => {
    const { handleDiscordSubagentProgress } = await loadDiscordSubagentProgressModule();
    await handleDiscordSubagentProgress(api, event);
  });
  api.on("subagent_ended", async (event) => {
    const { handleDiscordSubagentEnded } = await loadDiscordSubagentHooksModule();
    handleDiscordSubagentEnded(event);
  });
  api.on("subagent_delivery_target", async (event) => {
    const { handleDiscordSubagentDeliveryTarget } = await loadDiscordSubagentHooksModule();
    return handleDiscordSubagentDeliveryTarget(event);
  });
}
