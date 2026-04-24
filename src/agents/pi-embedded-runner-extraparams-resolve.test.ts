import { describe, expect, it } from "vitest";
import { resolveExtraParams } from "./pi-embedded-runner/extra-params.js";

describe("resolveExtraParams", () => {
  it("returns undefined with no model config", () => {
    const result = resolveExtraParams({
      cfg: undefined,
      provider: "zai",
      modelId: "glm-4.7",
    });

    expect(result).toBeUndefined();
  });

  it("applies default runtime params for OpenAI GPT-5 models", () => {
    const result = resolveExtraParams({
      cfg: undefined,
      provider: "openai",
      modelId: "gpt-5.4",
    });

    expect(result).toEqual({
      parallel_tool_calls: true,
      text_verbosity: "low",
      openaiWsWarmup: false,
    });
  });

  it("returns params for exact provider/model key", () => {
    const result = resolveExtraParams({
      cfg: {
        agents: {
          defaults: {
            models: {
              "openai/gpt-4": {
                params: {
                  temperature: 0.7,
                  maxTokens: 2048,
                },
              },
            },
          },
        },
      },
      provider: "openai",
      modelId: "gpt-4",
    });

    expect(result).toEqual({
      temperature: 0.7,
      maxTokens: 2048,
    });
  });

  it("ignores unrelated model entries", () => {
    const result = resolveExtraParams({
      cfg: {
        agents: {
          defaults: {
            models: {
              "openai/gpt-4": {
                params: {
                  temperature: 0.7,
                },
              },
            },
          },
        },
      },
      provider: "openai",
      modelId: "gpt-4.1-mini",
    });

    expect(result).toBeUndefined();
  });

  it("returns per-agent params when agentId matches", () => {
    const result = resolveExtraParams({
      cfg: {
        agents: {
          list: [
            {
              id: "risk-reviewer",
              params: { cacheRetention: "none" },
            },
          ],
        },
      },
      provider: "anthropic",
      modelId: "claude-opus-4-6",
      agentId: "risk-reviewer",
    });

    expect(result).toEqual({ cacheRetention: "none" });
  });

  it("merges per-agent params over global model defaults", () => {
    const result = resolveExtraParams({
      cfg: {
        agents: {
          defaults: {
            models: {
              "anthropic/claude-opus-4-6": {
                params: {
                  temperature: 0.5,
                  cacheRetention: "long",
                },
              },
            },
          },
          list: [
            {
              id: "risk-reviewer",
              params: { cacheRetention: "none" },
            },
          ],
        },
      },
      provider: "anthropic",
      modelId: "claude-opus-4-6",
      agentId: "risk-reviewer",
    });

    expect(result).toEqual({
      temperature: 0.5,
      cacheRetention: "none",
    });
  });

  it("preserves higher-precedence agent parallelToolCalls override across alias styles", () => {
    const result = resolveExtraParams({
      cfg: {
        agents: {
          defaults: {
            models: {
              "openai/gpt-4.1": {
                params: {
                  parallel_tool_calls: true,
                },
              },
            },
          },
          list: [
            {
              id: "main",
              params: {
                parallelToolCalls: false,
              },
            },
          ],
        },
      },
      provider: "openai",
      modelId: "gpt-4.1",
      agentId: "main",
    });

    expect(result).toEqual({
      parallel_tool_calls: false,
    });
  });

  it("canonicalizes text verbosity alias styles with agent override precedence", () => {
    const result = resolveExtraParams({
      cfg: {
        agents: {
          defaults: {
            models: {
              "openai/gpt-5.4": {
                params: {
                  text_verbosity: "high",
                },
              },
            },
          },
          list: [
            {
              id: "main",
              params: {
                textVerbosity: "low",
              },
            },
          ],
        },
      },
      provider: "openai",
      modelId: "gpt-5.4",
      agentId: "main",
    });

    expect(result).toEqual({
      openaiWsWarmup: false,
      parallel_tool_calls: true,
      text_verbosity: "low",
    });
  });

  it("ignores per-agent params when agentId does not match", () => {
    const result = resolveExtraParams({
      cfg: {
        agents: {
          list: [
            {
              id: "risk-reviewer",
              params: { cacheRetention: "none" },
            },
          ],
        },
      },
      provider: "anthropic",
      modelId: "claude-opus-4-6",
      agentId: "main",
    });

    expect(result).toBeUndefined();
  });
});
