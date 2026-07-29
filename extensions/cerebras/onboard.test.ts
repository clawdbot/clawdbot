import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { resolveAgentModelPrimaryValue } from "openclaw/plugin-sdk/provider-onboard";
import { describe, expect, it, vi } from "vitest";
import plugin from "./index.js";
import { applyCerebrasConfig, CEREBRAS_DEFAULT_MODEL_REF } from "./onboard.js";
import manifest from "./openclaw.plugin.json" with { type: "json" };

describe("Cerebras onboarding", () => {
  it("applies the manifest catalog, default, and alias", () => {
    const config = applyCerebrasConfig({});

    expect(config.models?.providers?.cerebras?.models.map((model) => model.id)).toEqual(
      manifest.modelCatalog.providers.cerebras.models.map((model) => model.id),
    );
    expect(resolveAgentModelPrimaryValue(config.agents?.defaults?.model)).toBe(
      CEREBRAS_DEFAULT_MODEL_REF,
    );
    expect(config.agents?.defaults?.models).toEqual({
      [CEREBRAS_DEFAULT_MODEL_REF]: { alias: "Cerebras Gemma 4 31B" },
    });
  });

  it("preserves an existing primary during non-interactive auth setup", async () => {
    const provider = await registerSingleProviderPlugin(plugin);
    const method = provider.auth?.[0];
    if (!method?.runNonInteractive) {
      throw new Error("expected Cerebras non-interactive auth method");
    }

    const result = await method.runNonInteractive({
      authChoice: "cerebras-api-key",
      config: {
        agents: {
          defaults: {
            model: { primary: "anthropic/claude-sonnet-4-6" },
            models: { "anthropic/claude-sonnet-4-6": { alias: "Existing" } },
          },
        },
      },
      opts: {},
      runtime: { error: vi.fn(), exit: vi.fn(), log: vi.fn() },
      resolveApiKey: vi.fn(async () => ({ key: "fixture-value", source: "profile" })),
      toApiKeyCredential: vi.fn(() => null),
    } as never);

    expect(resolveAgentModelPrimaryValue(result?.agents?.defaults?.model)).toBe(
      "anthropic/claude-sonnet-4-6",
    );
    expect(result?.agents?.defaults?.models).toEqual({
      "anthropic/claude-sonnet-4-6": { alias: "Existing" },
      [CEREBRAS_DEFAULT_MODEL_REF]: { alias: "Cerebras Gemma 4 31B" },
    });
  });
});
