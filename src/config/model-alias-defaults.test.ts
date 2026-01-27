import { describe, expect, it } from "vitest";
import { DEFAULT_CONTEXT_TOKENS } from "../agents/defaults.js";
import { applyModelDefaults } from "./defaults.js";
import type { MoltbotConfig } from "./types.js";

describe("applyModelDefaults", () => {
  it("adds default aliases when models are present", () => {
    const cfg = {
      agents: {
        defaults: {
          models: {
            "anthropic/claude-opus-4-5": {},
            "openai/gpt-5.2": {},
          },
        },
      },
    } satisfies MoltbotConfig;
    const next = applyModelDefaults(cfg);

    expect(next.agents?.defaults?.models?.["anthropic/claude-opus-4-5"]?.alias).toBe("opus");
    expect(next.agents?.defaults?.models?.["openai/gpt-5.2"]?.alias).toBe("gpt");
  });

  it("does not override existing aliases", () => {
    const cfg = {
      agents: {
        defaults: {
          models: {
            "anthropic/claude-opus-4-5": { alias: "Opus" },
          },
        },
      },
    } satisfies MoltbotConfig;

    const next = applyModelDefaults(cfg);

    expect(next.agents?.defaults?.models?.["anthropic/claude-opus-4-5"]?.alias).toBe("Opus");
  });

  it("respects explicit empty alias disables", () => {
    const cfg = {
      agents: {
        defaults: {
          models: {
            "google/gemini-3-pro-preview": { alias: "" },
            "google/gemini-3-flash-preview": {},
          },
        },
      },
    } satisfies MoltbotConfig;

    const next = applyModelDefaults(cfg);

    expect(next.agents?.defaults?.models?.["google/gemini-3-pro-preview"]?.alias).toBe("");
    expect(next.agents?.defaults?.models?.["google/gemini-3-flash-preview"]?.alias).toBe(
      "gemini-flash",
    );
  });

  it("fills missing model provider defaults", () => {
    const cfg = {
      models: {
        providers: {
          myproxy: {
            baseUrl: "https://proxy.example/v1",
            apiKey: "sk-test",
            api: "openai-completions",
            models: [{ id: "gpt-5.2", name: "GPT-5.2" }],
          },
        },
      },
    } satisfies MoltbotConfig;

    const next = applyModelDefaults(cfg);
    const model = next.models?.providers?.myproxy?.models?.[0];

    expect(model?.reasoning).toBe(false);
    expect(model?.input).toEqual(["text"]);
    expect(model?.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    expect(model?.contextWindow).toBe(DEFAULT_CONTEXT_TOKENS);
    expect(model?.maxTokens).toBe(8192);
  });
});
