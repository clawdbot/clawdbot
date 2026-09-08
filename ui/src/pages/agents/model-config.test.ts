// @vitest-environment node
// Control UI tests cover canonical per-agent model config writes.
import { describe, expect, it, vi } from "vitest";
import type { GatewayBrowserClient } from "../../api/gateway.ts";
import type { ApplicationGatewayPhase } from "../../app/gateway.ts";
import { createRuntimeConfigCapability } from "../../lib/config/runtime-config-capability.ts";
import { stageAgentModelFallbacks, stageAgentPrimaryModel } from "./model-config.ts";

function createRuntimeConfig(sourceConfig: Record<string, unknown>) {
  const client = {
    request: vi.fn(async (method: string) =>
      method === "config.get"
        ? {
            sourceConfig,
            hash: "hash-1",
            valid: true,
            issues: [],
          }
        : { hash: "hash-2" },
    ),
  } as unknown as GatewayBrowserClient;
  const snapshot = {
    client,
    phase: "connected" as ApplicationGatewayPhase,
    sessionKey: "main",
  };
  return createRuntimeConfigCapability({
    snapshot,
    subscribe: () => () => undefined,
  });
}

describe("agent model config", () => {
  it("writes primary and fallback changes through keyed agent entries", async () => {
    const runtimeConfig = createRuntimeConfig({
      agents: {
        defaults: { model: { primary: "openai/gpt-5.4" } },
        entries: { main: { default: true } },
      },
    });
    await runtimeConfig.ensureLoaded();

    stageAgentPrimaryModel(runtimeConfig, "main", "anthropic/claude-sonnet-4-6");
    stageAgentModelFallbacks(runtimeConfig, "main", ["openai/gpt-5.4"]);

    expect(runtimeConfig.state.configForm).toEqual({
      agents: {
        defaults: { model: { primary: "openai/gpt-5.4" } },
        entries: {
          main: {
            default: true,
            model: {
              primary: "anthropic/claude-sonnet-4-6",
              fallbacks: ["openai/gpt-5.4"],
            },
          },
        },
      },
    });
    expect(runtimeConfig.state.configForm?.agents).not.toHaveProperty("list");
    runtimeConfig.dispose();
  });

  it.each([
    { name: "an implicit primary", model: undefined },
    { name: "a shared string primary", model: "openai/gpt-5.4" },
    {
      name: "a shared object primary",
      model: { primary: "openai/gpt-5.4", fallbacks: ["google/gemini-3-pro"] },
    },
  ])("preserves $name when editing fallbacks", async ({ model }) => {
    const defaults = model === undefined ? {} : { model };
    const runtimeConfig = createRuntimeConfig({
      agents: { defaults, entries: { main: { default: true } } },
    });
    await runtimeConfig.ensureLoaded();

    stageAgentModelFallbacks(runtimeConfig, "main", [
      "google/gemini-3-pro",
      "anthropic/claude-sonnet-4-6",
    ]);

    expect(runtimeConfig.state.configForm).toEqual({
      agents: {
        defaults,
        entries: {
          main: {
            default: true,
            model: { fallbacks: ["google/gemini-3-pro", "anthropic/claude-sonnet-4-6"] },
          },
        },
      },
    });
    runtimeConfig.dispose();
  });

  it.each([
    {
      name: "an inherited primary",
      defaultModel: { primary: "openai/gpt-5.4", fallbacks: ["google/gemini-3-pro"] },
      model: { fallbacks: ["anthropic/claude-sonnet-4-6"] },
      expectedModel: { fallbacks: [] },
    },
    {
      name: "an implicit primary",
      defaultModel: { fallbacks: ["google/gemini-3-pro"] },
      model: { fallbacks: ["anthropic/claude-sonnet-4-6"] },
      expectedModel: { fallbacks: [] },
    },
    {
      name: "an authored primary",
      defaultModel: { primary: "google/gemini-3-pro" },
      model: { primary: "openai/gpt-5.4", fallbacks: ["anthropic/claude-sonnet-4-6"] },
      expectedModel: { primary: "openai/gpt-5.4", fallbacks: [] },
    },
  ])(
    "keeps an explicitly cleared fallback chain with $name",
    async ({ defaultModel, model, expectedModel }) => {
      const defaults = { model: defaultModel };
      const otherAgent = { model: "google/gemini-3-pro" };
      const runtimeConfig = createRuntimeConfig({
        agents: {
          defaults,
          entries: { main: { default: true, name: "Main", model }, other: otherAgent },
        },
      });
      await runtimeConfig.ensureLoaded();

      stageAgentModelFallbacks(runtimeConfig, "main", []);

      expect(runtimeConfig.state.configForm).toEqual({
        agents: {
          defaults,
          entries: {
            main: { default: true, name: "Main", model: expectedModel },
            other: otherAgent,
          },
        },
      });
      runtimeConfig.dispose();
    },
  );

  it("creates an empty override for an implicit agent only after an explicit clear", async () => {
    const defaults = { model: { fallbacks: ["google/gemini-3-pro"] } };
    const runtimeConfig = createRuntimeConfig({ agents: { defaults } });
    await runtimeConfig.ensureLoaded();
    expect(runtimeConfig.state.configForm).toEqual({ agents: { defaults } });
    expect(runtimeConfig.state.configFormDirty).toBe(false);

    stageAgentModelFallbacks(runtimeConfig, "main", []);

    expect(runtimeConfig.state.configForm).toEqual({
      agents: { defaults, entries: { main: { model: { fallbacks: [] } } } },
    });
    runtimeConfig.dispose();
  });

  it.each([{ fallbacks: ["openai/gpt-5.4"] }, { fallbacks: [] }])(
    "keeps authored fallbacks $fallbacks when the primary model is cleared",
    async ({ fallbacks }) => {
      const runtimeConfig = createRuntimeConfig({
        agents: {
          defaults: { model: { primary: "openai/gpt-5.4" } },
          entries: {
            main: {
              default: true,
              model: { primary: "anthropic/claude-sonnet-4-6", fallbacks },
            },
          },
        },
      });
      await runtimeConfig.ensureLoaded();

      stageAgentPrimaryModel(runtimeConfig, "main", null);

      expect(runtimeConfig.state.configForm).toEqual({
        agents: {
          defaults: { model: { primary: "openai/gpt-5.4" } },
          entries: {
            main: { default: true, model: { fallbacks } },
          },
        },
      });
      runtimeConfig.dispose();
    },
  );

  it("still removes the model node when clearing a primary with no fallbacks", async () => {
    const runtimeConfig = createRuntimeConfig({
      agents: {
        entries: { main: { default: true, model: "anthropic/claude-sonnet-4-6" } },
      },
    });
    await runtimeConfig.ensureLoaded();

    stageAgentPrimaryModel(runtimeConfig, "main", null);

    expect(runtimeConfig.state.configForm).toEqual({
      agents: { entries: { main: { default: true } } },
    });
    runtimeConfig.dispose();
  });
});
