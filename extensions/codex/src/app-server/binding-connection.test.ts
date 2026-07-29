// Codex tests cover private binding connection selection.
import { describe, expect, it } from "vitest";
import {
  requireCodexSupervisionModelSelection,
  resolveCodexBindingAppServerConnection,
} from "./binding-connection.js";
import { resolveCodexSupervisionAppServerRuntimeOptions } from "./config.js";
import { buildCodexAppServerConnectionFingerprint } from "./plugin-app-cache-key.js";

function supervisedBinding(pluginConfig: unknown) {
  return {
    connectionScope: "supervision" as const,
    appServerRuntimeFingerprint: buildCodexAppServerConnectionFingerprint(
      resolveCodexSupervisionAppServerRuntimeOptions({
        pluginConfig,
        env: {},
        requirementsToml: null,
      }),
    ),
  };
}

describe("Codex binding app-server connection", () => {
  it("preserves ordinary harness runtime and auth ownership", () => {
    const connection = resolveCodexBindingAppServerConnection({
      binding: {},
      authProfileId: "openai:work",
      env: {},
      requirementsToml: null,
    });

    expect(connection.appServer.start.homeScope).toBe("agent");
    expect(connection.usesSupervisionConnection).toBe(false);
    expect(connection.requestAuthProfileId).toBe("openai:work");
    expect(connection.clientAuthProfileId).toBe("openai:work");
  });

  it("uses native user-home auth only for an enabled supervised binding", () => {
    const connection = resolveCodexBindingAppServerConnection({
      binding: supervisedBinding({ supervision: { enabled: true } }),
      authProfileId: "openai:work",
      pluginConfig: { supervision: { enabled: true } },
      env: {},
      requirementsToml: null,
    });

    expect(connection.appServer.start.homeScope).toBe("user");
    expect(connection.usesSupervisionConnection).toBe(true);
    expect(connection.requestAuthProfileId).toBeUndefined();
    expect(connection.clientAuthProfileId).toBeNull();
  });

  it("requires the exact native model pair for materialized supervised requests", () => {
    expect(
      requireCodexSupervisionModelSelection({
        connectionScope: "supervision",
        model: " gpt-5.5 ",
        modelProvider: " openai ",
      }),
    ).toEqual({ model: "gpt-5.5", modelProvider: "openai" });

    expect(() =>
      requireCodexSupervisionModelSelection({
        connectionScope: "supervision",
        model: "gpt-5.5",
      }),
    ).toThrow("missing its native model and provider");
  });

  it("preserves an explicit supervised WebSocket endpoint while selecting native auth", () => {
    const connection = resolveCodexBindingAppServerConnection({
      binding: supervisedBinding({
        supervision: { enabled: true },
        appServer: { transport: "websocket", url: "ws://127.0.0.1:4500" },
      }),
      pluginConfig: {
        supervision: { enabled: true },
        appServer: { transport: "websocket", url: "ws://127.0.0.1:4500" },
      },
      env: {},
      requirementsToml: null,
    });

    expect(connection.appServer.start).toMatchObject({
      transport: "websocket",
      homeScope: "agent",
      url: "ws://127.0.0.1:4500",
    });
    expect(connection.clientAuthProfileId).toBeNull();
  });

  it("fails closed when a supervised binding remains after supervision is disabled", () => {
    expect(() =>
      resolveCodexBindingAppServerConnection({
        binding: { connectionScope: "supervision" },
        pluginConfig: { supervision: { enabled: false } },
        env: {},
        requirementsToml: null,
      }),
    ).toThrow("Codex supervision is disabled");
  });

  it("fails closed when a supervised binding connection changes", () => {
    const binding = supervisedBinding({
      supervision: { enabled: true },
      appServer: { transport: "websocket", url: "ws://127.0.0.1:4500" },
    });

    expect(() =>
      resolveCodexBindingAppServerConnection({
        binding,
        pluginConfig: {
          supervision: { enabled: true },
          appServer: { transport: "websocket", url: "ws://127.0.0.1:4600" },
        },
        env: {},
        requirementsToml: null,
      }),
    ).toThrow("supervision connection changed");
  });
});
