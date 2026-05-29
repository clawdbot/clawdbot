import fs from "node:fs";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { describe, expect, it, vi } from "vitest";

vi.mock("./harness.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./harness.js")>();
  return {
    ...actual,
    createCopilotAgentHarness: vi.fn(actual.createCopilotAgentHarness),
  };
});

import { createCopilotAgentHarness } from "./harness.js";
import plugin from "./index.js";

function loadManifest(): Record<string, unknown> {
  return JSON.parse(
    fs.readFileSync(new URL("./openclaw.plugin.json", import.meta.url), "utf8"),
  ) as Record<string, unknown>;
}

function registerWithPluginConfig(pluginConfig: Record<string, unknown> | undefined) {
  const registerAgentHarness = vi.fn();
  plugin.register(
    createTestPluginApi({
      id: "copilot",
      name: "GitHub Copilot agent runtime",
      source: "test",
      config: {},
      pluginConfig,
      runtime: {} as never,
      registerAgentHarness,
    }),
  );
  const harness = registerAgentHarness.mock.calls.at(0)?.at(0) as {
    id: string;
    label: string;
    supports(ctx: {
      provider: string;
      modelId?: string;
      requestedRuntime?: string;
    }): { supported: true; priority?: number } | { supported: false; reason?: string };
  };
  return { registerAgentHarness, harness };
}

describe("copilot plugin", () => {
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

  it("registers exactly one copilot agent harness and nothing else", () => {
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

    plugin.register(
      createTestPluginApi({
        id: "copilot",
        name: "GitHub Copilot agent runtime",
        source: "test",
        config: {},
        pluginConfig: {},
        runtime: {} as never,
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
  });

  it("registers a harness hard-bound to the canonical github-copilot provider", () => {
    const { harness } = registerWithPluginConfig({});

    expect(
      harness.supports({
        provider: "github-copilot",
        modelId: "gpt-4.1",
        requestedRuntime: "copilot",
      }),
    ).toEqual({ supported: true, priority: 100 });
    expect(
      harness.supports({
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

    expect(createHarness).toHaveBeenNthCalledWith(1, { poolOptions: { idleTtlMs: 2500 } });
    expect(createHarness.mock.calls[1]?.[0]).toBeUndefined();
  });
});
