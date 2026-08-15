// Discord plugin module persists online-greeting cooldowns across gateway restarts.
import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { getDiscordRuntime } from "../runtime.js";
import { DISCORD_PRESENCE_GREETING_COOLDOWN_MS } from "./presence-events.js";

const DISCORD_PRESENCE_COOLDOWN_MAX_ENTRIES = 25_000;

export function openDiscordPresenceCooldownStore(): PluginStateSyncKeyedStore<number> {
  return getDiscordRuntime().state.openSyncKeyedStore<number>({
    namespace: "presence-greeting-cooldowns",
    maxEntries: DISCORD_PRESENCE_COOLDOWN_MAX_ENTRIES,
    overflowPolicy: "reject-new",
    defaultTtlMs: DISCORD_PRESENCE_GREETING_COOLDOWN_MS,
  });
}
