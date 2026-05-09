import fs from "node:fs";
import { createTestPluginApi } from "openclaw/plugin-sdk/plugin-test-api";
import { describe, expect, it, vi } from "vitest";
import { createCodexAppServerAgentHarness } from "./harness.js";
import plugin from "./index.js";

describe("codex plugin", () => {
  it("is opt-in by default", () => {
    const manifest = JSON.parse(
      fs.readFileSync(new URL("./openclaw.plugin.json", import.meta.url), "utf8"),
    ) as { enabledByDefault?: unknown };

    expect(manifest.enabledByDefault).toBeUndefined();
  });

  it("registers the codex provider and agent harness", () => {
    const registerAgentHarness = vi.fn();
    const registerCommand = vi.fn();
    const registerMediaUnderstandingProvider = vi.fn();
    const registerMigrationProvider = vi.fn();
    const registerProvider = vi.fn();
    const on = vi.fn();
    const onConversationBindingResolved = vi.fn();

    plugin.register(
      createTestPluginApi({
        id: "codex",
        name: "Codex",
        source: "test",
        config: {},
        pluginConfig: {},
        runtime: {} as never,
        registerAgentHarness,
        registerCommand,
        registerMediaUnderstandingProvider,
        registerMigrationProvider,
        registerProvider,
        on,
        onConversationBindingResolved,
      }),
    );

    const providerRegistration = registerProvider.mock.calls[0]?.[0] as Record<string, unknown>;
    const agentHarnessRegistration = registerAgentHarness.mock.calls[0]?.[0] as Record<
      string,
      unknown
    >;
    const mediaProviderRegistration = registerMediaUnderstandingProvider.mock.calls[0]?.[0] as
      | Record<string, unknown>
      | undefined;
    const inboundClaimRegistration = on.mock.calls[0] as [unknown, unknown] | undefined;
    const bindingResolvedRegistration = onConversationBindingResolved.mock.calls[0] as
      | [unknown]
      | undefined;

    expect(providerRegistration).toMatchObject({ id: "codex", label: "Codex" });
    expect(agentHarnessRegistration).toMatchObject({
      id: "codex",
      label: "Codex agent harness",
      deliveryDefaults: { sourceVisibleReplies: "message_tool" },
    });
    expect(typeof agentHarnessRegistration.dispose).toBe("function");
    expect(mediaProviderRegistration).toMatchObject({
      id: "codex",
      capabilities: ["image"],
      defaultModels: { image: "gpt-5.5" },
    });
    expect(typeof mediaProviderRegistration?.describeImage).toBe("function");
    expect(typeof mediaProviderRegistration?.describeImages).toBe("function");
    expect(registerCommand.mock.calls[0]?.[0]).toMatchObject({
      name: "codex",
      description: "Inspect and control the Codex app-server harness",
    });
    expect(registerMigrationProvider.mock.calls[0]?.[0]).toMatchObject({
      id: "codex",
      label: "Codex",
    });
    expect(inboundClaimRegistration?.[0]).toBe("inbound_claim");
    expect(typeof inboundClaimRegistration?.[1]).toBe("function");
    expect(typeof bindingResolvedRegistration?.[0]).toBe("function");
  });

  it("registers with capture APIs that do not expose conversation binding hooks yet", () => {
    const api = createTestPluginApi({
      id: "codex",
      name: "Codex",
      source: "test",
      config: {},
      pluginConfig: {},
      runtime: {} as never,
      registerAgentHarness: vi.fn(),
      registerCommand: vi.fn(),
      registerMediaUnderstandingProvider: vi.fn(),
      registerProvider: vi.fn(),
      on: vi.fn(),
    }) as ReturnType<typeof createTestPluginApi> & {
      onConversationBindingResolved?: ReturnType<typeof vi.fn>;
    };
    delete (api as { onConversationBindingResolved?: unknown }).onConversationBindingResolved;

    plugin.register(api);
    expect(api.registerProvider).toHaveBeenCalledWith(expect.objectContaining({ id: "codex" }));
  });

  it("only claims the codex provider by default", () => {
    const harness = createCodexAppServerAgentHarness();

    expect(harness.deliveryDefaults?.sourceVisibleReplies).toBe("message_tool");
    expect(
      harness.supports({ provider: "codex", modelId: "gpt-5.4", requestedRuntime: "auto" })
        .supported,
    ).toBe(true);
    expect(
      harness.supports({
        provider: "openai-codex",
        modelId: "gpt-5.4",
        requestedRuntime: "auto",
      }),
    ).toMatchObject({ supported: false });
  });
});
