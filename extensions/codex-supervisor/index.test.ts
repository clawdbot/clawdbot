// Codex Supervisor tests cover index plugin behavior.
import { createCapturedPluginRegistration } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, vi } from "vitest";
import entry from "./index.js";

describe("codex-supervisor plugin entry", () => {
  it("registers supervisor tools from plugin config", () => {
    const captured = createCapturedPluginRegistration({ id: "codex-supervisor" });
    const registerGatewayMethod = vi.fn();
    const registerNodeHostCommand = vi.fn();
    const registerNodeInvokePolicy = vi.fn();
    captured.api.registerGatewayMethod = registerGatewayMethod;
    captured.api.registerNodeHostCommand = registerNodeHostCommand;
    captured.api.registerNodeInvokePolicy = registerNodeInvokePolicy;
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
    expect(captured.controlUiDescriptors).toEqual([
      {
        surface: "tab",
        id: "sessions",
        label: "Codex Sessions",
        description: "Codex sessions on this Gateway and paired nodes.",
        icon: "terminal",
        group: "control",
        requiredScopes: ["operator.write"],
      },
    ]);
    expect(captured.cliRegistrars[0]).toMatchObject({
      descriptors: [
        {
          name: "codex",
          description: "Inspect Codex sessions across the Gateway and paired nodes",
          hasSubcommands: true,
        },
      ],
    });
    expect(registerGatewayMethod).toHaveBeenCalledWith(
      "codex-supervisor.sessions.list",
      expect.any(Function),
      { scope: "operator.write" },
    );
    expect(registerNodeHostCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        command: "codex.appServer.threads.list.v1",
        cap: "codex-app-server-threads",
        dangerous: false,
      }),
    );
    expect(registerNodeInvokePolicy).toHaveBeenCalledWith(
      expect.objectContaining({
        commands: ["codex.appServer.threads.list.v1"],
        defaultPlatforms: ["macos", "linux", "windows"],
      }),
    );
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
