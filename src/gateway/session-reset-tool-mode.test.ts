import { expect, test } from "vitest";
import { createEmptyPluginRegistry } from "../plugins/registry-empty.js";
import { setActivePluginRegistry } from "../plugins/runtime.js";
import { writeSessionStore } from "./test-helpers.js";
import {
  setupGatewaySessionsHandlerTestHarness,
  sessionStoreEntry,
} from "./test/server-sessions.test-helpers.js";

const { createSessionStoreDir } = setupGatewaySessionsHandlerTestHarness();

test("sessions.reset clears a carried Tool mode when the reset runtime is incompatible", async () => {
  const { writeConfigFile } = await import("../config/config.js");
  const registry = createEmptyPluginRegistry();
  registry.sessionToolModes.push({
    pluginId: "developer-mode",
    mode: {
      id: "code",
      label: "Code",
      controlLabel: "Tool mode",
      toolProfile: "coding",
      codeMode: "code",
    },
    source: "test",
  });
  setActivePluginRegistry(registry);
  await writeConfigFile({
    agents: {
      defaults: {
        model: { primary: "openai/gpt-5.6-luna" },
        models: {
          "openai/gpt-5.6-luna": { agentRuntime: { id: "codex" } },
        },
      },
    },
  });
  try {
    await createSessionStoreDir();
    await writeSessionStore({
      entries: {
        main: sessionStoreEntry("sess-main", {
          toolMode: { pluginId: "developer-mode", modeId: "code" },
        }),
      },
    });
    const { performGatewaySessionReset } = await import("./session-reset-service.js");
    const reset = await performGatewaySessionReset({
      key: "main",
      reason: "reset",
      commandSource: "gateway:sessions.reset",
      workerPlacementContext: {},
    });

    expect(reset.ok).toBe(true);
    if (!reset.ok || "incognitoDeleted" in reset) {
      throw new Error("expected reset session entry");
    }
    expect(reset.entry.toolMode).toBeUndefined();
  } finally {
    setActivePluginRegistry(createEmptyPluginRegistry());
    await writeConfigFile({});
  }
});
