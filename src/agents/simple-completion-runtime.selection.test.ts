import { describe, expect, it } from "vitest";
import type { OpenClawConfig } from "../config/config.js";
import { resolveSimpleCompletionSelectionForAgent } from "./simple-completion-runtime.js";

function requireSelection(selection: ReturnType<typeof resolveSimpleCompletionSelectionForAgent>) {
  if (!selection) {
    throw new Error("expected simple completion selection");
  }
  return selection;
}

describe("resolveSimpleCompletionSelectionForAgent", () => {
  it("preserves multi-segment model ids (openrouter provider models)", () => {
    const cfg = {
      agents: {
        defaults: { model: "openrouter/anthropic/claude-sonnet-4-6" },
      },
    } as OpenClawConfig;

    const selection = requireSelection(
      resolveSimpleCompletionSelectionForAgent({ cfg, agentId: "main" }),
    );
    expect(selection.provider).toBe("openrouter");
    expect(selection.modelId).toBe("anthropic/claude-sonnet-4-6");
  });

  it("uses the routed agent model override when present", () => {
    const cfg = {
      agents: {
        defaults: { model: "anthropic/claude-opus-4-6" },
        list: [{ id: "ops", model: "openrouter/aurora-alpha" }],
      },
    } as OpenClawConfig;

    const selection = requireSelection(
      resolveSimpleCompletionSelectionForAgent({ cfg, agentId: "ops" }),
    );
    expect(selection.provider).toBe("openrouter");
    expect(selection.modelId).toBe("openrouter/aurora-alpha");
  });

  it("keeps trailing auth profile for credential lookup", () => {
    const cfg = {
      agents: {
        defaults: { model: "anthropic/claude-opus-4-6@work" },
      },
    } as OpenClawConfig;

    const selection = requireSelection(
      resolveSimpleCompletionSelectionForAgent({ cfg, agentId: "main" }),
    );
    expect(selection.provider).toBe("anthropic");
    expect(selection.modelId).toBe("claude-opus-4-6");
    expect(selection.profileId).toBe("work");
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

    const selection = requireSelection(
      resolveSimpleCompletionSelectionForAgent({ cfg, agentId: "main" }),
    );
    expect(selection.provider).toBe("openrouter");
    expect(selection.modelId).toBe("anthropic/claude-sonnet-4-6");
    expect(selection.profileId).toBe("work");
  });

  it("uses Codex execution provider for OpenAI model refs with Codex runtime policy", () => {
    const cfg = {
      agents: {
        defaults: {
          model: "openai/gpt-5.4-mini",
          models: {
            "openai/gpt-5.4-mini": { agentRuntime: { id: "codex" } },
          },
        },
      },
    } as OpenClawConfig;

    const selection = requireSelection(
      resolveSimpleCompletionSelectionForAgent({ cfg, agentId: "main" }),
    );
    expect(selection.provider).toBe("openai");
    expect(selection.modelId).toBe("gpt-5.4-mini");
    expect(selection.runtimeProvider).toBe("openai-codex");
  });

  it("falls back to runtime default model when no explicit model is configured", () => {
    const cfg = {} as OpenClawConfig;

    const selection = requireSelection(
      resolveSimpleCompletionSelectionForAgent({ cfg, agentId: "main" }),
    );
    expect(selection.provider).toBe("openai");
    expect(selection.modelId).toBe("gpt-5.5");
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

    const selection = requireSelection(
      resolveSimpleCompletionSelectionForAgent({ cfg, agentId: "main" }),
    );
    expect(selection.provider).toBe("openai");
    expect(selection.modelId).toBe("gpt-5.5");
  });
});
