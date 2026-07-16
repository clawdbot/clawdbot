import { describe, expect, it } from "vitest";
import type { ModelDefinitionConfig } from "../../config/types.models.js";
import { buildContextOverflowRecoveryText } from "./agent-runner-context-recovery.js";

function makeTestModel(id: string, contextTokens: number): ModelDefinitionConfig {
  return {
    id,
    name: id,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: contextTokens,
    contextTokens,
    maxTokens: 4096,
  };
}

describe("buildContextOverflowRecoveryText", () => {
  it.each([
    [99_999, "20000"],
    [100_000, "35000"],
    [199_999, "35000"],
    [200_000, "50000"],
    [999_999, "50000"],
    [1_000_000, "100000"],
  ])("selects the reserve floor for a %i-token model", (contextTokens, expectedFloor) => {
    const text = buildContextOverflowRecoveryText({
      cfg: {
        models: {
          providers: {
            test: {
              baseUrl: "https://provider.test",
              models: [makeTestModel("model", contextTokens)],
            },
          },
        },
      },
      primaryProvider: "test",
      primaryModel: "model",
    });

    expect(text).toContain(`reserveTokensFloor\` to ${expectedFloor}`);
  });

  it("keeps the generic compaction-buffer hint without heartbeat model evidence", () => {
    const text = buildContextOverflowRecoveryText({
      cfg: {},
      primaryProvider: "openrouter",
      primaryModel: "qwen3.6-plus",
    });

    expect(text).toContain("reserveTokensFloor");
    expect(text).toContain("20000");
    expect(text).not.toContain("heartbeat model bleed");
  });

  it("suggests 100000 reserveTokensFloor for 1M context models", () => {
    const text = buildContextOverflowRecoveryText({
      cfg: {
        models: {
          providers: {
            openrouter: {
              baseUrl: "https://openrouter.test",
              models: [makeTestModel("qwen3.6-plus", 1_000_000)],
            },
          },
        },
      },
      primaryProvider: "openrouter",
      primaryModel: "qwen3.6-plus",
    });

    expect(text).toContain("reserveTokensFloor");
    expect(text).toContain("100000");
    expect(text).not.toContain("heartbeat model bleed");
  });

  it("suggests 50000 reserveTokensFloor for 200k context models", () => {
    const text = buildContextOverflowRecoveryText({
      cfg: {
        models: {
          providers: {
            openrouter: {
              baseUrl: "https://openrouter.test",
              models: [makeTestModel("gpt-5.5-200k", 200_000)],
            },
          },
        },
      },
      primaryProvider: "openrouter",
      primaryModel: "gpt-5.5-200k",
    });

    expect(text).toContain("reserveTokensFloor");
    expect(text).toContain("50000");
    expect(text).not.toContain("heartbeat model bleed");
  });

  it("suggests 35000 reserveTokensFloor for 100k context models", () => {
    const text = buildContextOverflowRecoveryText({
      cfg: {
        models: {
          providers: {
            openrouter: {
              baseUrl: "https://openrouter.test",
              models: [makeTestModel("gpt-5.5", 100_000)],
            },
          },
        },
      },
      primaryProvider: "openrouter",
      primaryModel: "gpt-5.5",
    });

    expect(text).toContain("reserveTokensFloor");
    expect(text).toContain("35000");
    expect(text).not.toContain("heartbeat model bleed");
  });

  it("suggests 20000 reserveTokensFloor for small context windows", () => {
    const text = buildContextOverflowRecoveryText({
      cfg: {
        models: {
          providers: {
            ollama: {
              baseUrl: "http://ollama.test",
              models: [makeTestModel("qwen3.5-9b-32k:latest", 32_768)],
            },
          },
        },
      },
      primaryProvider: "ollama",
      primaryModel: "qwen3.5-9b-32k:latest",
    });

    expect(text).toContain("reserveTokensFloor");
    expect(text).toContain("20000");
    expect(text).not.toContain("heartbeat model bleed");
  });

  it("uses session contextTokens as fallback when model metadata is unavailable", () => {
    const text = buildContextOverflowRecoveryText({
      cfg: {},
      primaryProvider: "openrouter",
      primaryModel: "unknown-model",
      activeSessionEntry: {
        sessionId: "session",
        updatedAt: 1,
        modelProvider: "openrouter",
        model: "unknown-model",
        contextTokens: 200_000,
      },
    });

    expect(text).toContain("reserveTokensFloor");
    expect(text).toContain("50000");
    expect(text).not.toContain("heartbeat model bleed");
  });

  it("prefers model metadata over session contextTokens", () => {
    const text = buildContextOverflowRecoveryText({
      cfg: {
        models: {
          providers: {
            openrouter: {
              baseUrl: "https://openrouter.test",
              models: [makeTestModel("qwen3.6-plus", 1_000_000)],
            },
          },
        },
      },
      primaryProvider: "openrouter",
      primaryModel: "qwen3.6-plus",
      activeSessionEntry: {
        sessionId: "session",
        updatedAt: 1,
        modelProvider: "openrouter",
        model: "qwen3.6-plus",
        contextTokens: 32_768,
      },
    });

    expect(text).toContain("reserveTokensFloor");
    expect(text).toContain("100000");
    expect(text).not.toContain("heartbeat model bleed");
  });

  it("keeps the preserved-session copy with the existing overflow hint", () => {
    const text = buildContextOverflowRecoveryText({
      preserveSessionMapping: true,
      cfg: {},
      primaryProvider: "openrouter",
      primaryModel: "qwen3.6-plus",
    });

    expect(text).toContain("kept this conversation mapped to the current session");
    expect(text).toContain("reserveTokensFloor");
    expect(text).not.toContain("reset our conversation");
  });

  it("falls back to session entry model when runtimeProvider is not provided", () => {
    const text = buildContextOverflowRecoveryText({
      cfg: {
        models: {
          providers: {
            ollama: {
              baseUrl: "http://ollama.test",
              models: [makeTestModel("qwen3.5-9b-32k:latest", 32_768)],
            },
          },
        },
      },
      primaryProvider: "openrouter",
      primaryModel: "unknown-model",
      activeSessionEntry: {
        sessionId: "session",
        updatedAt: 1,
        modelProvider: "ollama",
        model: "qwen3.5-9b-32k:latest",
        contextTokens: 200_000,
      },
    });

    expect(text).toContain("reserveTokensFloor");
    expect(text).toContain("20000");
    expect(text).not.toContain("heartbeat model bleed");
  });

  it("prefers session entry model context over session contextTokens numeric value", () => {
    const text = buildContextOverflowRecoveryText({
      cfg: {
        models: {
          providers: {
            ollama: {
              baseUrl: "http://ollama.test",
              models: [makeTestModel("qwen3.5-9b-32k:latest", 32_768)],
            },
          },
        },
      },
      primaryProvider: "openrouter",
      primaryModel: "unknown-model",
      activeSessionEntry: {
        sessionId: "session",
        updatedAt: 1,
        modelProvider: "ollama",
        model: "qwen3.5-9b-32k:latest",
        contextTokens: 1_000_000,
      },
    });

    expect(text).toContain("reserveTokensFloor");
    expect(text).toContain("20000");
    expect(text).not.toContain("heartbeat model bleed");
  });

  it("uses session contextTokens before primary metadata for uncataloged runtime models", () => {
    const text = buildContextOverflowRecoveryText({
      cfg: {
        models: {
          providers: {
            openrouter: {
              baseUrl: "https://openrouter.test",
              models: [makeTestModel("qwen3.6-plus", 1_000_000)],
            },
          },
        },
      },
      primaryProvider: "openrouter",
      primaryModel: "qwen3.6-plus",
      activeSessionEntry: {
        sessionId: "session",
        updatedAt: 1,
        modelProvider: "custom",
        model: "uncataloged-32k",
        contextTokens: 32_768,
      },
    });

    expect(text).toContain("reserveTokensFloor");
    expect(text).toContain("20000");
    expect(text).not.toContain("100000");
    expect(text).not.toContain("heartbeat model bleed");
  });

  it("does not use primary metadata for explicit uncataloged runtime models", () => {
    const text = buildContextOverflowRecoveryText({
      cfg: {
        models: {
          providers: {
            openrouter: {
              baseUrl: "https://openrouter.test",
              models: [makeTestModel("qwen3.6-plus", 1_000_000)],
            },
          },
        },
      },
      primaryProvider: "openrouter",
      primaryModel: "qwen3.6-plus",
      runtimeProvider: "custom",
      runtimeModel: "uncataloged-32k",
    });

    expect(text).toContain("reserveTokensFloor");
    expect(text).toContain("20000");
    expect(text).not.toContain("100000");
    expect(text).not.toContain("heartbeat model bleed");
  });

  it("does not use stale session contextTokens for explicit uncataloged runtime models", () => {
    const text = buildContextOverflowRecoveryText({
      cfg: {},
      primaryProvider: "openrouter",
      primaryModel: "qwen3.6-plus",
      runtimeProvider: "custom",
      runtimeModel: "uncataloged-32k",
      activeSessionEntry: {
        sessionId: "session",
        updatedAt: 1,
        modelProvider: "openrouter",
        model: "qwen3.6-plus",
        contextTokens: 1_000_000,
      },
    });

    expect(text).toContain("reserveTokensFloor");
    expect(text).toContain("20000");
    expect(text).not.toContain("100000");
    expect(text).not.toContain("heartbeat model bleed");
  });

  it("caps reserveTokensFloor hint by agent.defaults.contextTokens", () => {
    const text = buildContextOverflowRecoveryText({
      cfg: {
        models: {
          providers: {
            openrouter: {
              baseUrl: "https://openrouter.test",
              models: [makeTestModel("qwen3.6-plus", 1_000_000)],
            },
          },
        },
        agents: {
          defaults: {
            contextTokens: 100_000,
          },
        },
      },
      primaryProvider: "openrouter",
      primaryModel: "qwen3.6-plus",
    });

    expect(text).toContain("reserveTokensFloor");
    expect(text).toContain("35000");
    expect(text).not.toContain("100000");
    expect(text).not.toContain("heartbeat model bleed");
  });

  it("caps reserveTokensFloor hint by per-agent contextTokens over defaults", () => {
    const text = buildContextOverflowRecoveryText({
      cfg: {
        models: {
          providers: {
            openrouter: {
              baseUrl: "https://openrouter.test",
              models: [makeTestModel("qwen3.6-plus", 1_000_000)],
            },
          },
        },
        agents: {
          defaults: {
            contextTokens: 200_000,
          },
          list: [
            {
              id: "capped-agent",
              contextTokens: 32_768,
            },
          ],
        },
      },
      primaryProvider: "openrouter",
      primaryModel: "qwen3.6-plus",
      agentId: "capped-agent",
    });

    expect(text).toContain("reserveTokensFloor");
    expect(text).toContain("20000");
    expect(text).not.toContain("50000");
    expect(text).not.toContain("heartbeat model bleed");
  });

  it("caps the session contextTokens fallback by agent contextTokens", () => {
    const text = buildContextOverflowRecoveryText({
      cfg: {
        agents: {
          defaults: {
            contextTokens: 200_000,
          },
        },
      },
      primaryProvider: "openrouter",
      primaryModel: "unknown-model",
      activeSessionEntry: {
        sessionId: "session",
        updatedAt: 1,
        modelProvider: "openrouter",
        model: "unknown-model",
        contextTokens: 32_768,
      },
    });

    expect(text).toContain("reserveTokensFloor");
    expect(text).toContain("20000");
    expect(text).not.toContain("50000");
    expect(text).not.toContain("heartbeat model bleed");
  });

  it("uses runtime model over primary model when both are available", () => {
    const text = buildContextOverflowRecoveryText({
      cfg: {
        models: {
          providers: {
            openrouter: {
              baseUrl: "https://openrouter.test",
              models: [makeTestModel("qwen3.6-plus", 1_000_000)],
            },
            ollama: {
              baseUrl: "http://ollama.test",
              models: [makeTestModel("qwen3.5-9b-32k:latest", 32_768)],
            },
          },
        },
      },
      primaryProvider: "openrouter",
      primaryModel: "qwen3.6-plus",
      runtimeProvider: "ollama",
      runtimeModel: "qwen3.5-9b-32k:latest",
    });

    expect(text).toContain("reserveTokensFloor");
    expect(text).toContain("20000");
    expect(text).not.toContain("100000");
    expect(text).not.toContain("heartbeat model bleed");
  });

  it("uses runtime model with 200k context when primary is 1M", () => {
    const text = buildContextOverflowRecoveryText({
      cfg: {
        models: {
          providers: {
            openrouter: {
              baseUrl: "https://openrouter.test",
              models: [makeTestModel("qwen3.6-plus", 1_000_000)],
            },
            openai: {
              baseUrl: "https://openai.test",
              models: [makeTestModel("gpt-5.5-200k", 200_000)],
            },
          },
        },
      },
      primaryProvider: "openrouter",
      primaryModel: "qwen3.6-plus",
      runtimeProvider: "openai",
      runtimeModel: "gpt-5.5-200k",
    });

    expect(text).toContain("reserveTokensFloor");
    expect(text).toContain("50000");
    expect(text).not.toContain("100000");
    expect(text).not.toContain("heartbeat model bleed");
  });

  it("does not use stale heartbeat bleed hints for different explicit runtime refs", () => {
    const text = buildContextOverflowRecoveryText({
      cfg: {
        agents: {
          defaults: {
            heartbeat: { model: "ollama/qwen3.5-9b-32k:latest" },
          },
        },
      },
      primaryProvider: "openrouter",
      primaryModel: "qwen3.6-plus",
      runtimeProvider: "custom",
      runtimeModel: "uncataloged-32k",
      activeSessionEntry: {
        sessionId: "session",
        updatedAt: 1,
        modelProvider: "ollama",
        model: "qwen3.5-9b-32k:latest",
        contextTokens: 32_768,
      },
    });

    expect(text).toContain("reserveTokensFloor");
    expect(text).toContain("20000");
    expect(text).not.toContain("heartbeat model bleed");
  });

  it("points to heartbeat model bleed when the last runtime model matches configured heartbeat.model", () => {
    const text = buildContextOverflowRecoveryText({
      cfg: {
        models: {
          providers: {
            openrouter: {
              baseUrl: "https://openrouter.test",
              models: [makeTestModel("qwen3.6-plus", 1_000_000)],
            },
            ollama: {
              baseUrl: "http://ollama.test",
              models: [makeTestModel("qwen3.5-9b-32k:latest", 32_768)],
            },
          },
        },
        agents: {
          defaults: {
            heartbeat: { model: "ollama/qwen3.5-9b-32k:latest" },
          },
        },
      },
      agentId: "agent",
      primaryProvider: "openrouter",
      primaryModel: "qwen3.6-plus",
      activeSessionEntry: {
        sessionId: "session",
        updatedAt: 1,
        modelProvider: "ollama",
        model: "qwen3.5-9b-32k:latest",
        contextTokens: 32_768,
      },
    });

    expect(text).toContain("ollama/qwen3.5-9b-32k:latest (32k context)");
    expect(text).toContain("openrouter/qwen3.6-plus");
    expect(text).toContain("heartbeat model bleed");
    expect(text).toContain("heartbeat.isolatedSession");
    expect(text).not.toContain("reserveTokensFloor");
  });

  it("uses the stored session context window as the uncataloged runtime model fallback", () => {
    const text = buildContextOverflowRecoveryText({
      cfg: {
        models: {
          providers: {
            openrouter: {
              baseUrl: "https://openrouter.test",
              models: [makeTestModel("qwen3.6-plus", 1_000_000)],
            },
          },
        },
        agents: {
          defaults: {
            contextTokens: 100_000,
            heartbeat: { model: "ollama/custom-32k" },
          },
        },
      },
      agentId: "agent",
      primaryProvider: "openrouter",
      primaryModel: "qwen3.6-plus",
      activeSessionEntry: {
        sessionId: "session",
        updatedAt: 1,
        modelProvider: "ollama",
        model: "custom-32k",
        contextTokens: 32_768,
      },
    });

    expect(text).toContain("ollama/custom-32k (32k context)");
    expect(text).not.toContain("ollama/custom-32k (98k context)");
    expect(text).toContain("heartbeat model bleed");
  });

  it("does not blame heartbeat when the stored session fallback matches the capped primary window", () => {
    const text = buildContextOverflowRecoveryText({
      cfg: {
        models: {
          providers: {
            openrouter: {
              baseUrl: "https://openrouter.test",
              models: [makeTestModel("qwen3.6-plus", 1_000_000)],
            },
          },
        },
        agents: {
          defaults: {
            contextTokens: 100_000,
            heartbeat: { model: "ollama/custom-large" },
          },
        },
      },
      agentId: "agent",
      primaryProvider: "openrouter",
      primaryModel: "qwen3.6-plus",
      activeSessionEntry: {
        sessionId: "session",
        updatedAt: 1,
        modelProvider: "ollama",
        model: "custom-large",
        contextTokens: 200_000,
      },
    });

    expect(text).toContain("reserveTokensFloor");
    expect(text).not.toContain("heartbeat model bleed");
  });

  it("does not blame heartbeat when the same agent cap constrains both cataloged models", () => {
    const text = buildContextOverflowRecoveryText({
      cfg: {
        models: {
          providers: {
            openrouter: {
              baseUrl: "https://openrouter.test",
              models: [makeTestModel("qwen3.6-plus", 1_000_000)],
            },
            ollama: {
              baseUrl: "http://ollama.test",
              models: [makeTestModel("custom-large", 1_000_000)],
            },
          },
        },
        agents: {
          defaults: {
            contextTokens: 100_000,
            heartbeat: { model: "ollama/custom-large" },
          },
        },
      },
      agentId: "agent",
      primaryProvider: "openrouter",
      primaryModel: "qwen3.6-plus",
      activeSessionEntry: {
        sessionId: "session",
        updatedAt: 1,
        modelProvider: "ollama",
        model: "custom-large",
        contextTokens: 1_000_000,
      },
    });

    expect(text).toContain("reserveTokensFloor");
    expect(text).not.toContain("heartbeat model bleed");
  });

  it("does not blame heartbeat when the smaller runtime model is not the configured heartbeat model", () => {
    const text = buildContextOverflowRecoveryText({
      cfg: {
        agents: {
          defaults: {
            heartbeat: { model: "ollama/qwen3.5-9b-32k:latest" },
          },
        },
      },
      primaryProvider: "openrouter",
      primaryModel: "qwen3.6-plus",
      activeSessionEntry: {
        sessionId: "session",
        updatedAt: 1,
        modelProvider: "anthropic",
        model: "claude-haiku-4-5",
        contextTokens: 32_768,
      },
    });

    expect(text).toContain("reserveTokensFloor");
    expect(text).not.toContain("heartbeat model bleed");
  });
});
