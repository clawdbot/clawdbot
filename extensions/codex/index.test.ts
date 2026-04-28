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
        registerProvider,
        on,
        onConversationBindingResolved,
      }),
    );

    expect(registerProvider.mock.calls[0]?.[0]).toMatchObject({ id: "codex", label: "Codex" });
    expect(registerAgentHarness.mock.calls[0]?.[0]).toMatchObject({
      id: "codex",
      label: "Codex agent harness",
      dispose: expect.any(Function),
    });
    expect(registerMediaUnderstandingProvider.mock.calls[0]?.[0]).toMatchObject({
      id: "codex",
      capabilities: ["image"],
      defaultModels: { image: "gpt-5.5" },
      describeImage: expect.any(Function),
      describeImages: expect.any(Function),
    });
    expect(registerCommand.mock.calls[0]?.[0]).toMatchObject({
      name: "codex",
      description: "Inspect and control the Codex app-server harness",
    });
    expect(on).toHaveBeenCalledWith("inbound_claim", expect.any(Function));
    expect(onConversationBindingResolved).toHaveBeenCalledWith(expect.any(Function));
  });

  it("only claims the codex provider by default", () => {
    const harness = createCodexAppServerAgentHarness();

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
