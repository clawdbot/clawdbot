// Copilot plugin entrypoint registers its OpenClaw integration.
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
import type { PluginStateSyncKeyedStore } from "openclaw/plugin-sdk/plugin-state-runtime";
import { isRecord } from "openclaw/plugin-sdk/string-coerce-runtime";
import { createCopilotAgentHarness, type CopilotSessionBinding } from "./harness.js";

function readPoolOptions(pluginConfig: unknown): { idleTtlMs: number } | undefined {
  if (!isRecord(pluginConfig)) {
    return undefined;
  }

  const pool = pluginConfig.pool;
  if (!isRecord(pool)) {
    return undefined;
  }

  const idleTtlMs = pool.idleTtlMs;
  if (typeof idleTtlMs !== "number" || !Number.isFinite(idleTtlMs) || idleTtlMs < 1) {
    return undefined;
  }

  return { idleTtlMs };
}

export default definePluginEntry({
  id: "copilot",
  name: "GitHub Copilot agent runtime",
  description: "Registers the GitHub Copilot agent runtime.",
  register(api) {
    if (
      api.registrationMode !== "full" &&
      api.registrationMode !== "discovery" &&
      api.registrationMode !== "tool-discovery"
    ) {
      return;
    }
    const poolOptions = readPoolOptions(api.pluginConfig);
    // Prepared registries discover the harness without activating runtime state.
    // Resolve the trusted store only when a harness operation needs a binding.
    let sessionStore: PluginStateSyncKeyedStore<CopilotSessionBinding> | undefined;
    const getSessionStore = () =>
      (sessionStore ??= api.runtime.state.openSyncKeyedStore<CopilotSessionBinding>({
        namespace: "sdk-sessions",
        maxEntries: 5000,
        defaultTtlMs: 90 * 24 * 60 * 60 * 1000,
      }));

    api.registerAgentHarness(
      createCopilotAgentHarness({
        ...(poolOptions ? { poolOptions } : {}),
        sessionStore: {
          register: (key, value, options) => getSessionStore().register(key, value, options),
          lookup: (key) => getSessionStore().lookup(key),
          delete: (key) => getSessionStore().delete(key),
        },
      }),
    );
  },
});
