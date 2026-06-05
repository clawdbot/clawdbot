// Codex Supervisor tests cover index plugin behavior.
import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it } from "vitest";
import entry from "./index.js";

describe("codex-supervisor plugin entry", () => {
  it("registers supervisor tools from plugin config", () => {
    const captured = createCapturedPluginRegistration({ id: "codex-supervisor" });
    captured.api.pluginConfig = {
      endpoints: [
        {
          id: "test",
          transport: "websocket",
          url: "ws://127.0.0.1:12345",
        },
      ],
      allowRawTranscripts: true,
      allowWriteControls: true,
    };

    entry.register(captured.api);

    expect(captured.tools.map((tool) => tool.name).toSorted()).toEqual([
      "codex_endpoint_probe",
      "codex_session_interrupt",
      "codex_session_read",
      "codex_session_send",
      "codex_sessions_list",
    ]);
    expect(captured.runtimeLifecycles).toHaveLength(1);
    expect(captured.runtimeLifecycles[0]).toMatchObject({
      id: "codex-supervisor",
      description: "Close Codex supervisor app-server connections.",
    });
    expect(entry.configSchema.jsonSchema).toMatchObject({
      type: "object",
      properties: {
        endpoints: { type: "array" },
        allowRawTranscripts: { type: "boolean" },
        allowWriteControls: { type: "boolean" },
      },
    });
  });
});
