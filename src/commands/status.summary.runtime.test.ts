import { describe, expect, it } from "vitest";
import { statusSummaryRuntime } from "./status.summary.runtime.js";

describe("statusSummaryRuntime.resolveContextTokensForModel", () => {
  it("matches provider context window overrides across canonical provider aliases", () => {
    const contextTokens = statusSummaryRuntime.resolveContextTokensForModel({
      cfg: {
        models: {
          providers: {
            "z.ai": {
              models: [{ id: "glm-4.7", contextWindow: 123_456 }],
            },
          },
        },
      } as never,
      provider: "z-ai",
      model: "glm-4.7",
      fallbackContextTokens: 999,
    });

    expect(contextTokens).toBe(123_456);
  });

  it("prefers per-model contextTokens over contextWindow", () => {
    const contextTokens = statusSummaryRuntime.resolveContextTokensForModel({
      cfg: {
        models: {
          providers: {
            "openai-codex": {
              models: [{ id: "gpt-5.4", contextWindow: 1_050_000, contextTokens: 272_000 }],
            },
          },
        },
      } as never,
      provider: "openai-codex",
      model: "gpt-5.4",
      fallbackContextTokens: 999,
    });

    expect(contextTokens).toBe(272_000);
  });
});

describe("statusSummaryRuntime.classifySessionKey", () => {
  it("classifies cron history sessions distinctly", () => {
    expect(statusSummaryRuntime.classifySessionKey("agent:main:cron:daily-digest")).toBe("cron");
    expect(
      statusSummaryRuntime.classifySessionKey("agent:avery:cron:daily-digest:run:abc123"),
    ).toBe("cron");
  });
});

describe("statusSummaryRuntime.resolveSessionRuntimeLabel", () => {
  it("uses the shared /status runtime labels for persisted harness metadata", () => {
    expect(
      statusSummaryRuntime.resolveSessionRuntimeLabel({
        cfg: {} as never,
        entry: {
          sessionId: "session-1",
          updatedAt: 0,
          agentRuntimeOverride: "codex",
        },
        provider: "openai",
        model: "gpt-5.5",
        sessionKey: "agent:main:main",
      }),
    ).toBe("OpenAI Codex");
  });

  it("preserves configured default CLI runtimes when sessions lack persisted harness metadata", () => {
    expect(
      statusSummaryRuntime.resolveSessionRuntimeLabel({
        cfg: {
          agents: {
            defaults: {
              agentRuntime: { id: "claude-cli" },
            },
          },
        } as never,
        entry: {
          sessionId: "session-1",
          updatedAt: 0,
        },
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        sessionKey: "agent:main:main",
      }),
    ).toBe("Claude CLI");
  });

  it("preserves configured agent runtimes before harness selection", () => {
    expect(
      statusSummaryRuntime.resolveSessionRuntimeLabel({
        cfg: {
          agents: {
            defaults: {
              agentRuntime: { id: "pi" },
            },
            list: [
              {
                id: "research",
                agentRuntime: { id: "codex" },
              },
            ],
          },
        } as never,
        entry: {
          sessionId: "session-1",
          updatedAt: 0,
        },
        provider: "openai",
        model: "gpt-5.5",
        agentId: "research",
        sessionKey: "agent:research:main",
      }),
    ).toBe("OpenAI Codex");
  });
});

describe("statusSummaryRuntime.resolveSessionModelRef", () => {
  const cfg = {
    agents: {
      defaults: {
        model: { primary: "anthropic/claude-sonnet-4-6" },
      },
    },
  } as never;

  it("preserves explicit runtime providers for vendor-prefixed model ids", () => {
    expect(
      statusSummaryRuntime.resolveSessionModelRef(cfg, {
        modelProvider: "openrouter",
        model: "anthropic/claude-haiku-4.5",
      }),
    ).toEqual({
      provider: "openrouter",
      model: "anthropic/claude-haiku-4.5",
    });
  });

  it("splits legacy combined overrides when provider is missing", () => {
    expect(
      statusSummaryRuntime.resolveSessionModelRef(cfg, {
        modelOverride: "ollama-beelink2/qwen2.5-coder:7b",
      }),
    ).toEqual({
      provider: "ollama-beelink2",
      model: "qwen2.5-coder:7b",
    });
  });

  it("uses the configured default provider for providerless runtime models", () => {
    expect(
      statusSummaryRuntime.resolveSessionModelRef(
        {
          agents: {
            defaults: {
              model: { primary: "openai/gpt-5.5" },
            },
          },
        } as never,
        {
          model: "gpt-5.5",
        },
      ),
    ).toEqual({
      provider: "openai",
      model: "gpt-5.5",
    });
  });

  it("prefers explicit overrides ahead of fallback runtime fields", () => {
    expect(
      statusSummaryRuntime.resolveSessionModelRef(cfg, {
        providerOverride: "openai-codex",
        modelOverride: "gpt-5.4",
        modelProvider: "amazon-bedrock",
        model: "minimax.minimax-m2.5",
      }),
    ).toEqual({
      provider: "openai-codex",
      model: "gpt-5.4",
    });
  });

  it("falls back to configured defaults when persisted session model fields are malformed", () => {
    expect(
      statusSummaryRuntime.resolveSessionModelRef(cfg, {
        modelProvider: { provider: "openai" },
        model: false,
        providerOverride: ["anthropic"],
        modelOverride: 123,
      } as never),
    ).toEqual({
      provider: "anthropic",
      model: "claude-sonnet-4-6",
    });
  });
});
