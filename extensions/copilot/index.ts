// Copilot plugin entrypoint registers its OpenClaw integration.
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";
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
    // Copilot is a full-runtime plugin (registers an agent harness).
    // Metadata-only registration paths (discovery, cli-metadata, setup-only)
    // cannot supply a durable session store — skip registration here and let
    // the full gateway activation path pick it up later.
    if (api.registrationMode !== "full") {
      return;
    }
    const poolOptions = readPoolOptions(api.pluginConfig);
    const sessionStore = api.runtime.state.openSyncKeyedStore<CopilotSessionBinding>({
      namespace: "sdk-sessions",
      maxEntries: 5000,
      defaultTtlMs: 90 * 24 * 60 * 60 * 1000,
    });

    api.registerAgentHarness(
      createCopilotAgentHarness({
        ...(poolOptions ? { poolOptions } : {}),
        sessionStore,
      }),
    );
  },
});
