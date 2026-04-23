import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-entry-contract";

type DiscordSubagentHooksModule = typeof import("./src/subagent-hooks.js");

let discordSubagentHooksPromise: Promise<DiscordSubagentHooksModule> | null = null;

function loadDiscordSubagentHooksModule() {
  discordSubagentHooksPromise ??= import("./src/subagent-hooks.js");
  return discordSubagentHooksPromise;
}

// Subagent hooks live behind a dedicated barrel so the bundled entry can
// register one stable hook wiring path while keeping the handler module lazy.
export function registerDiscordSubagentHooks(api: OpenClawPluginApi): void {
  api.on("subagent_spawning", async (event) => {
    const { handleDiscordSubagentSpawning } = await loadDiscordSubagentHooksModule();
    return await handleDiscordSubagentSpawning(api, event);
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

export {
  handleDiscordSubagentDeliveryTarget,
  handleDiscordSubagentEnded,
  handleDiscordSubagentSpawning,
} from "./src/subagent-hooks.js";
