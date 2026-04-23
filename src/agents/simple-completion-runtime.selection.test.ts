import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveSimpleCompletionSelectionForAgent } from "./simple-completion-runtime.js";

describe("resolveSimpleCompletionSelectionForAgent", () => {
  it("preserves multi-segment model ids (openrouter provider models)", () => {
    const cfg = {
      agents: {
        defaults: { model: "openrouter/anthropic/claude-sonnet-4-6" },
      },
    } as OpenClawConfig;

    const selection = resolveSimpleCompletionSelectionForAgent({ cfg, agentId: "main" });
    expect(selection).toEqual(
      expect.objectContaining({
        provider: "openrouter",
        modelId: "anthropic/claude-sonnet-4-6",
      }),
    );
  });

  it("uses the routed agent model override when present", () => {
    const cfg = {
      agents: {
        defaults: { model: "anthropic/claude-opus-4-6" },
        list: [{ id: "ops", model: "openrouter/aurora-alpha" }],
      },
    } as OpenClawConfig;

    const selection = resolveSimpleCompletionSelectionForAgent({ cfg, agentId: "ops" });
    expect(selection).toEqual(
      expect.objectContaining({
        provider: "openrouter",
        modelId: "openrouter/aurora-alpha",
      }),
    );
  });

  it("keeps trailing auth profile for credential lookup", () => {
    const cfg = {
      agents: {
        defaults: { model: "anthropic/claude-opus-4-6@work" },
      },
    } as OpenClawConfig;

    const selection = resolveSimpleCompletionSelectionForAgent({ cfg, agentId: "main" });
    expect(selection).toEqual(
      expect.objectContaining({
        provider: "anthropic",
        modelId: "claude-opus-4-6",
        profileId: "work",
      }),
    );
  });

  it("resolves alias refs before parsing provider/model", () => {
    const cfg = {
      agents: {
        defaults: {
          model: "fast@work",
          models: {
            "openrouter/anthropic/claude-sonnet-4-6": { alias: "fast" },
          },
        },
      },
    } as OpenClawConfig;

    const selection = resolveSimpleCompletionSelectionForAgent({ cfg, agentId: "main" });
    expect(selection).toEqual(
      expect.objectContaining({
        provider: "openrouter",
        modelId: "anthropic/claude-sonnet-4-6",
        profileId: "work",
      }),
    );
  });

  it("falls back to runtime default model when no explicit model is configured", () => {
    const cfg = {} as OpenClawConfig;

    const selection = resolveSimpleCompletionSelectionForAgent({ cfg, agentId: "main" });
    expect(selection).toEqual(
      expect.objectContaining({
        provider: "openai",
        modelId: "gpt-5.5",
      }),
    );
  });

  it("uses configured provider fallback when default provider is unavailable", () => {
    const cfg = {
      models: {
        providers: {
          openai: {
            baseUrl: "https://api.openai.com/v1",
            models: [
              {
                id: "gpt-5",
                name: "GPT-5",
                reasoning: false,
                input: ["text"],
                cost: {
                  input: 0,
                  output: 0,
                  cacheRead: 0,
                  cacheWrite: 0,
                },
                contextWindow: 200_000,
                maxTokens: 8192,
              },
            ],
          },
        },
      },
    } as OpenClawConfig;

    const selection = resolveSimpleCompletionSelectionForAgent({ cfg, agentId: "main" });
    expect(selection).toEqual(
      expect.objectContaining({
        provider: "openai",
        modelId: "gpt-5.5",
      }),
    );
  });
});
