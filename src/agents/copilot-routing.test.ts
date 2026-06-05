// Covers when model selection should install the Copilot runtime plugin.
import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/types.openclaw.js";
import { modelSelectionShouldEnsureCopilotRuntimePlugin } from "./copilot-routing.js";

const emptyCfg = {} as OpenClawConfig;

function cfgWithProviderRuntime(id: string): OpenClawConfig {
  return {
    models: {
      providers: {
        "github-copilot": { agentRuntime: { id } },
      },
    },
  } as unknown as OpenClawConfig;
}

function cfgWithModelRuntime(modelId: string, id: string): OpenClawConfig {
  return {
    models: {
      providers: {
        "github-copilot": {
          models: [{ id: modelId, agentRuntime: { id } }],
        },
      },
    },
  } as unknown as OpenClawConfig;
}

describe("modelSelectionShouldEnsureCopilotRuntimePlugin", () => {
  it("returns false for github-copilot/* without explicit agentRuntime opt-in", () => {
    // Built-in GitHub Copilot provider already supports these models;
    // we must not install the runtime plugin unless users opted in.
    expect(
      modelSelectionShouldEnsureCopilotRuntimePlugin({
        model: "github-copilot/gpt-4o",
        config: emptyCfg,
      }),
    ).toBe(false);
  });

  it("returns true when the provider config sets agentRuntime.id = copilot", () => {
    expect(
      modelSelectionShouldEnsureCopilotRuntimePlugin({
        model: "github-copilot/gpt-4o",
        config: cfgWithProviderRuntime("copilot"),
      }),
    ).toBe(true);
  });

  it("returns true when a model override sets agentRuntime.id = copilot", () => {
    expect(
      modelSelectionShouldEnsureCopilotRuntimePlugin({
        model: "github-copilot/claude-sonnet-4",
        config: cfgWithModelRuntime("claude-sonnet-4", "copilot"),
      }),
    ).toBe(true);
  });

  it("normalizes id casing/whitespace before matching", () => {
    expect(
      modelSelectionShouldEnsureCopilotRuntimePlugin({
        model: "github-copilot/gpt-4o",
        config: cfgWithProviderRuntime("  Copilot  "),
      }),
    ).toBe(true);
  });

  it("returns false when the runtime id is anything other than copilot", () => {
    expect(
      modelSelectionShouldEnsureCopilotRuntimePlugin({
        model: "github-copilot/gpt-4o",
        config: cfgWithProviderRuntime("pi"),
      }),
    ).toBe(false);
    expect(
      modelSelectionShouldEnsureCopilotRuntimePlugin({
        model: "github-copilot/gpt-4o",
        config: cfgWithProviderRuntime("codex"),
      }),
    ).toBe(false);
  });

  it("model-scope override takes precedence over provider scope", () => {
    // A model override can intentionally opt out even when the provider default
    // opts into the Copilot runtime plugin.
    const cfg = {
      models: {
        providers: {
          "github-copilot": {
            agentRuntime: { id: "copilot" },
            models: [{ id: "gpt-4o", agentRuntime: { id: "pi" } }],
          },
        },
      },
    } as unknown as OpenClawConfig;
    expect(
      modelSelectionShouldEnsureCopilotRuntimePlugin({
        model: "github-copilot/gpt-4o",
        config: cfg,
      }),
    ).toBe(false);
    // A different model that has no override still inherits the provider-level opt-in.
    expect(
      modelSelectionShouldEnsureCopilotRuntimePlugin({
        model: "github-copilot/claude-sonnet-4",
        config: cfg,
      }),
    ).toBe(true);
  });

  it("returns false for other providers regardless of agentRuntime config", () => {
    const cfg = {
      models: {
        providers: {
          openai: { agentRuntime: { id: "copilot" } },
        },
      },
    } as unknown as OpenClawConfig;
    expect(
      modelSelectionShouldEnsureCopilotRuntimePlugin({ model: "openai/gpt-4o", config: cfg }),
    ).toBe(false);
    expect(
      modelSelectionShouldEnsureCopilotRuntimePlugin({
        model: "anthropic/claude-3",
        config: emptyCfg,
      }),
    ).toBe(false);
    expect(
      modelSelectionShouldEnsureCopilotRuntimePlugin({
        model: "openai/gpt-4o",
        config: emptyCfg,
      }),
    ).toBe(false);
  });

  it("returns false for undefined, empty, or unprefixed model refs", () => {
    expect(modelSelectionShouldEnsureCopilotRuntimePlugin({ config: emptyCfg })).toBe(false);
    expect(modelSelectionShouldEnsureCopilotRuntimePlugin({ model: "", config: emptyCfg })).toBe(
      false,
    );
    expect(
      modelSelectionShouldEnsureCopilotRuntimePlugin({ model: "gpt-4o", config: emptyCfg }),
    ).toBe(false);
    expect(
      modelSelectionShouldEnsureCopilotRuntimePlugin({
        model: "github-copilot/",
        config: emptyCfg,
      }),
    ).toBe(false);
  });
});
