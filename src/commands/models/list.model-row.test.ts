import { describe, expect, it } from "vitest";
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
  it("keeps native context metadata and effective runtime context tokens distinct", () => {
    const row = toModelRow({
      model: {
        ...OPENROUTER_MODEL,
        contextWindow: 400_000,
        contextTokens: 272_000,
      } as never,
      key: "openrouter/openai/gpt-5.4",
      tags: [],
    });

    expect(row.contextWindow).toBe(400_000);
    expect(row.contextTokens).toBe(272_000);
  });

  it("marks models available from auth profiles without loading model discovery", () => {
    const row = toModelRow({
      model: OPENROUTER_MODEL as never,
      key: "openrouter/openai/gpt-5.4",
      tags: [],
      hasAuthForProvider: (provider) => provider === "openrouter",
    });

    expect(row.available).toBe(true);
  });
});
