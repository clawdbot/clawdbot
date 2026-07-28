// Slack plugin module persists presence-greeting cooldowns across gateway restarts.
import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { getSlackRuntime } from "../runtime.js";
import { SLACK_PRESENCE_GREETING_COOLDOWN_MS } from "./presence-monitor.js";

const SLACK_PRESENCE_COOLDOWN_MAX_ENTRIES = 25_000;

export function openSlackPresenceCooldownStore(): PluginStateSyncKeyedStore<number> {
  return getSlackRuntime().state.openSyncKeyedStore<number>({
    namespace: "presence-greeting-cooldowns",
    maxEntries: SLACK_PRESENCE_COOLDOWN_MAX_ENTRIES,
    overflowPolicy: "reject-new",
    defaultTtlMs: SLACK_PRESENCE_GREETING_COOLDOWN_MS,
  });
}
