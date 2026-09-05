// Copilot tests cover index plugin behavior.
import fs from "node:fs";
import { createTestPluginApi, type TestPluginApiInput } from "openclaw/plugin-sdk/plugin-test-api";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./src/runtime.js", () => ({
  createCopilotClientPool: vi.fn(() => {
    throw new Error("registration and stored-session reset must not start the SDK pool");
  }),
}));

vi.mock("./harness.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./harness.js")>();
  return {
    ...actual,
    createCopilotAgentHarness: vi.fn(actual.createCopilotAgentHarness),
  };
});

import { createCopilotAgentHarness, type CopilotSessionBinding } from "./harness.js";
import plugin from "./index.js";
import { createCopilotClientPool } from "./src/runtime.js";

function loadManifest(): Record<string, unknown> {
  return JSON.parse(
    fs.readFileSync(new URL("./openclaw.plugin.json", import.meta.url), "utf8"),
  ) as Record<string, unknown>;
}

function registerWithPluginConfig(
  pluginConfig: Record<string, unknown> | undefined,
  registrationMode: TestPluginApiInput["registrationMode"] = "full",
) {
  const registerAgentHarness =
    vi.fn<(harness: ReturnType<typeof createCopilotAgentHarness>) => void>();
  const entries = new Map<string, CopilotSessionBinding>();
  const sessionStore = {
    register: vi.fn((key: string, value: CopilotSessionBinding) => {
      entries.set(key, value);
    }),
    lookup: vi.fn((key: string) => entries.get(key)),
    delete: vi.fn((key: string) => entries.delete(key)),
  };
  const openSyncKeyedStore = vi.fn(() => sessionStore);
  plugin.register(
    createTestPluginApi({
      id: "copilot",
      name: "GitHub Copilot agent runtime",
      source: "test",
      config: {},
      pluginConfig,
      registrationMode,
      runtime: { state: { openSyncKeyedStore } } as never,
      registerAgentHarness,
    }),
  );
  const harness = registerAgentHarness.mock.calls[0]?.[0];
  return { registerAgentHarness, harness, openSyncKeyedStore, sessionStore, entries };
}

describe("copilot plugin", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("is opt-in by default and only declares an agent harness activation", () => {
    const manifest = loadManifest();
    const activation = manifest.activation as Record<string, unknown>;

    expect(manifest.enabledByDefault).toBeUndefined();
    expect(activation.onStartup).toBe(false);
    expect(activation.onAgentHarnesses).toEqual(["copilot"]);
    expect(manifest.providers).toBeUndefined();
    expect(typeof manifest.version).toBe("string");
    expect(manifest.version).not.toBe("");
  });

  it.each(["full", "discovery", "tool-discovery"] as const)(
    "registers exactly one inert copilot agent harness in %s mode",
    (registrationMode) => {
      const registerAgentHarness = vi.fn();
      const registerProvider = vi.fn();
      const registerModelCatalogProvider = vi.fn();
      const registerMediaUnderstandingProvider = vi.fn();
      const registerMigrationProvider = vi.fn();
      const registerCommand = vi.fn();
      const registerNodeHostCommand = vi.fn();
      const registerNodeInvokePolicy = vi.fn();
      const on = vi.fn();
      const onConversationBindingResolved = vi.fn();
      const openSyncKeyedStore = vi.fn(() => {
        throw new Error("registration must not open state");
      });

      plugin.register(
        createTestPluginApi({
          id: "copilot",
          name: "GitHub Copilot agent runtime",
          source: "test",
          config: {},
          pluginConfig: {},
          registrationMode,
          runtime: { state: { openSyncKeyedStore } } as never,
          registerAgentHarness,
          registerProvider,
          registerModelCatalogProvider,
          registerMediaUnderstandingProvider,
          registerMigrationProvider,
          registerCommand,
          registerNodeHostCommand,
          registerNodeInvokePolicy,
          on,
          onConversationBindingResolved,
        }),
      );

      expect(registerAgentHarness).toHaveBeenCalledTimes(1);
      expect(registerAgentHarness).toHaveBeenCalledWith(
        expect.objectContaining({ id: "copilot", label: "GitHub Copilot agent runtime" }),
      );
      expect(registerProvider).not.toHaveBeenCalled();
      expect(registerModelCatalogProvider).not.toHaveBeenCalled();
      expect(registerMediaUnderstandingProvider).not.toHaveBeenCalled();
      expect(registerMigrationProvider).not.toHaveBeenCalled();
      expect(registerCommand).not.toHaveBeenCalled();
      expect(registerNodeHostCommand).not.toHaveBeenCalled();
      expect(registerNodeInvokePolicy).not.toHaveBeenCalled();
      expect(on).not.toHaveBeenCalled();
      expect(onConversationBindingResolved).not.toHaveBeenCalled();
      expect(openSyncKeyedStore).not.toHaveBeenCalled();
      expect(createCopilotClientPool).not.toHaveBeenCalled();
    },
  );

  it.each(["cli-metadata", "setup-only", "setup-runtime"] as const)(
    "skips harness and state registration in %s mode",
    (registrationMode) => {
      const { registerAgentHarness, openSyncKeyedStore } = registerWithPluginConfig(
        {},
        registrationMode,
      );

      expect(registerAgentHarness).not.toHaveBeenCalled();
      expect(openSyncKeyedStore).not.toHaveBeenCalled();
      expect(createCopilotAgentHarness).not.toHaveBeenCalled();
      expect(createCopilotClientPool).not.toHaveBeenCalled();
    },
  );

  it("supports github-copilot and rejects providers without BYOK ownership facts", () => {
    const { harness } = registerWithPluginConfig({});
    expect(harness).toBeDefined();

    expect(
      harness!.supports({
        provider: "github-copilot",
        modelId: "gpt-4.1",
        requestedRuntime: "copilot",
      }),
    ).toEqual({ supported: true, priority: 100 });
    expect(
      harness!.supports({
        provider: "anthropic",
        modelId: "claude-sonnet-4.5",
        requestedRuntime: "copilot",
      }),
    ).toEqual({
      supported: false,
      reason: "provider is not one of: github-copilot",
    });
  });

  it("passes through a valid pool idle TTL and ignores malformed values", () => {
    const createHarness = vi.mocked(createCopilotAgentHarness);
    createHarness.mockClear();

    registerWithPluginConfig({ pool: { idleTtlMs: 2500 } });
    registerWithPluginConfig({ pool: { idleTtlMs: 0 } });

    expect(createHarness).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ poolOptions: { idleTtlMs: 2500 } }),
    );
    expect(createHarness.mock.calls[1]?.[0]).not.toHaveProperty("poolOptions");
  });

  it("lazily opens and reuses the durable store when a discovered harness resets a stored session", async () => {
    const { harness, openSyncKeyedStore, sessionStore, entries } = registerWithPluginConfig(
      {},
      "discovery",
    );
    expect(harness).toBeDefined();
    expect(openSyncKeyedStore).not.toHaveBeenCalled();
    entries.set("stored-session", {
      schemaVersion: 2,
      sdkSessionId: "sdk-session",
      compatKey: "compat",
      compactKey: "compact",
      authMode: "useLoggedInUser",
      updatedAt: 1,
    });

    await harness!.reset!({ sessionId: "stored-session" });

    expect(openSyncKeyedStore).toHaveBeenCalledWith({
      namespace: "sdk-sessions",
      maxEntries: 5000,
      defaultTtlMs: 90 * 24 * 60 * 60 * 1000,
    });
    expect(sessionStore.lookup).toHaveBeenCalledWith("stored-session");
    expect(sessionStore.delete).toHaveBeenCalledWith("stored-session");
    expect(entries.has("stored-session")).toBe(false);

    await harness!.reset!({ sessionId: "stored-session" });
    await harness!.dispose?.();
    expect(openSyncKeyedStore).toHaveBeenCalledTimes(1);
    expect(sessionStore.delete).toHaveBeenCalledTimes(1);
    expect(createCopilotClientPool).not.toHaveBeenCalled();
  });
});
