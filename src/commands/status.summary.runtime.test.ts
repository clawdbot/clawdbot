// Status summary runtime tests cover model context-token resolution.
import { describe, expect, it } from "vitest";
import { ANTHROPIC_CONTEXT_1M_TOKENS } from "../agents/context-resolution.js";
import { migratePersistedImplicitMainRoster } from "../config/legacy.roster.js";
import { statusSummaryRuntime } from "./status.summary.runtime.js";

function resolveSessionRuntimeLabel(
  params: Parameters<typeof statusSummaryRuntime.resolveSessionRuntimeLabel>[0],
) {
  return statusSummaryRuntime.resolveSessionRuntimeLabel({
    ...params,
    cfg: migratePersistedImplicitMainRoster(params.cfg).config as never,
  });
}

describe("statusSummaryRuntime.resolveContextTokensForModel", () => {
  it("does not match provider context window overrides across provider id variants", () => {
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

    expect(contextTokens).toBe(999);
  });

  it("prefers per-model contextTokens over contextWindow", () => {
    const contextTokens = statusSummaryRuntime.resolveContextTokensForModel({
      cfg: {
        models: {
          providers: {
            openai: {
              models: [{ id: "gpt-5.4", contextWindow: 1_050_000, contextTokens: 272_000 }],
            },
          },
        },
      } as never,
      provider: "openai",
      model: "gpt-5.4",
      fallbackContextTokens: 999,
    });

    expect(contextTokens).toBe(272_000);
  });

  it("caps an oversized override without raising a lower override", () => {
    const cfg = {
      models: {
        providers: {
          openai: {
            models: [{ id: "gpt-5.5", contextWindow: 272_000 }],
          },
        },
      },
    } as never;
    const resolveOverride = (contextTokensOverride: number) =>
      statusSummaryRuntime.resolveContextTokensForModel({
        cfg,
        provider: "openai",
        model: "gpt-5.5",
        contextTokensOverride,
        fallbackContextTokens: 999,
      });

    expect(resolveOverride(1_000_000)).toBe(272_000);
    expect(resolveOverride(128_000)).toBe(128_000);
  });

  it("caps cold-cache overrides with prepared static catalog metadata", () => {
    expect(
      statusSummaryRuntime.resolveContextTokensForModel({
        cfg: {},
        provider: "openai",
        model: "gpt-5.5",
        modelContextWindow: 1_000_000,
        modelContextTokens: 272_000,
        contextTokensOverride: 1_000_000,
        fallbackContextTokens: 200_000,
      }),
    ).toBe(272_000);
  });

  it("combines configured native windows with lower prepared runtime caps", () => {
    expect(
      statusSummaryRuntime.resolveContextTokensForModel({
        cfg: {
          models: {
            providers: {
              openai: {
                models: [{ id: "gpt-5.5", contextWindow: 1_000_000 }],
              },
            },
          },
        } as never,
        provider: "openai",
        model: "gpt-5.5",
        modelContextTokens: 272_000,
        contextTokensOverride: 1_000_000,
      }),
    ).toBe(272_000);
  });

  it("matches self-prefixed configured ids through provider ownership", () => {
    expect(
      statusSummaryRuntime.resolveContextTokensForModel({
        cfg: {
          models: {
            providers: {
              "google-gemini-cli": {
                models: [
                  {
                    id: "google-gemini-cli/gemini-3.1-pro-preview",
                    contextTokens: 1_000_000,
                  },
                ],
              },
            },
          },
        } as never,
        provider: "google-gemini-cli",
        model: "gemini-3.1-pro-preview",
        contextTokensOverride: 2_000_000,
      }),
    ).toBe(1_000_000);
  });

  it("uses provider defaults and fixed Anthropic windows when capping overrides", () => {
    expect(
      statusSummaryRuntime.resolveContextTokensForModel({
        cfg: {
          models: {
            providers: {
              ollama: {
                contextWindow: 32_000,
                models: [{ id: "qwen3.5:9b" }],
              },
            },
          },
        } as never,
        provider: "ollama",
        model: "qwen3.5:9b",
        contextTokensOverride: 100_000,
      }),
    ).toBe(32_000);

    expect(
      statusSummaryRuntime.resolveContextTokensForModel({
        cfg: {
          models: {
            providers: {
              anthropic: {
                models: [{ id: "claude-sonnet-4-6", contextWindow: 200_000 }],
              },
            },
          },
        } as never,
        sourceCfg: {},
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        contextTokensOverride: 1_200_000,
      }),
    ).toBe(ANTHROPIC_CONTEXT_1M_TOKENS);
  });

  it.each([
    { contextTokens: 200_000, expected: 200_000 },
    { contextTokens: 2_000_000, expected: ANTHROPIC_CONTEXT_1M_TOKENS },
  ])(
    "bounds Anthropic contextTokens=$contextTokens by the fixed native window",
    ({ contextTokens, expected }) => {
      expect(
        statusSummaryRuntime.resolveContextTokensForModel({
          cfg: {
            models: {
              providers: {
                anthropic: {
                  models: [
                    {
                      id: "claude-sonnet-4-6",
                      contextWindow: ANTHROPIC_CONTEXT_1M_TOKENS,
                      contextTokens,
                    },
                  ],
                },
              },
            },
          } as never,
          provider: "anthropic",
          model: "claude-sonnet-4-6",
          contextTokensOverride: 1_200_000,
        }),
      ).toBe(expected);
    },
  );
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
  it("uses the shared /status runtime label for the implicit OpenAI Codex route", () => {
    expect(
      resolveSessionRuntimeLabel({
        cfg: {} as never,
        entry: {
          sessionId: "session-1",
          updatedAt: 0,
        },
        provider: "openai",
        model: "gpt-5.5",
        sessionKey: "agent:main:main",
      }),
    ).toBe("OpenAI Codex");
  });

  it("preserves configured default model CLI runtimes", () => {
    expect(
      resolveSessionRuntimeLabel({
        cfg: {
          agents: {
            defaults: {
              models: {
                "anthropic/claude-sonnet-4-6": { agentRuntime: { id: "claude-cli" } },
              },
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

  it("preserves configured agent model runtimes before harness selection", () => {
    expect(
      resolveSessionRuntimeLabel({
        cfg: {
          agents: {
            defaults: {
              models: {
                "openai/gpt-5.5": { agentRuntime: { id: "openclaw" } },
              },
            },
            list: [
              {
                id: "research",
                models: {
                  "openai/gpt-5.5": { agentRuntime: { id: "codex" } },
                },
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

  it("reports the owning Codex harness for a locked session with stale OpenClaw metadata", () => {
    expect(
      resolveSessionRuntimeLabel({
        cfg: {
          agents: {
            defaults: {
              models: {
                "openai/gpt-5.5": { agentRuntime: { id: "openclaw" } },
              },
            },
          },
        } as never,
        entry: {
          sessionId: "locked-codex-session",
          updatedAt: 0,
          agentHarnessId: "codex",
          agentRuntimeOverride: "openclaw",
          modelSelectionLocked: true,
        },
        provider: "openai",
        model: "gpt-5.5",
        sessionKey: "agent:main:main",
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
        providerOverride: "openai",
        modelOverride: "gpt-5.4",
        modelProvider: "amazon-bedrock",
        model: "minimax.minimax-m2.5",
      }),
    ).toEqual({
      provider: "openai",
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
