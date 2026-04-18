import { describe, expect, it } from "vitest";
import type { AuthProfileStore } from "../../agents/auth-profiles/types.js";
import { toModelRow } from "./list.model-row.js";

const OPENROUTER_MODEL = {
  provider: "openrouter",
  id: "openai/gpt-5.4",
  name: "GPT-5.4 via OpenRouter",
  api: "openai-chat-completions",
  baseUrl: "https://openrouter.ai/api/v1",
  input: ["text"],
  contextWindow: 1_000_000,
  maxTokens: 128_000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
} as const;

describe("toModelRow", () => {
  it("marks models available from auth profiles without loading model discovery", () => {
    const authStore: AuthProfileStore = {
      version: 1,
      profiles: {
        "openrouter:default": {
          type: "api_key",
          provider: "openrouter",
          key: "sk-or-v1-regression-test",
        },
      },
    };

    const row = toModelRow({
      model: OPENROUTER_MODEL as never,
      key: "openrouter/openai/gpt-5.4",
      tags: [],
      cfg: {},
      authStore,
    });

    expect(row.available).toBe(true);
  });
});
