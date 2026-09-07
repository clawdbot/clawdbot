import { describe, expect, it } from "vitest";
import type { Model } from "../types.js";
import { streamOpenAICompletions } from "./openai-completions.js";

describe("OpenAI Chat Completions cache metadata", () => {
  it.each([
    {
      id: "gpt-5.4",
      compat: undefined,
      key: "session-123",
      lifetime: { prompt_cache_retention: "24h" },
    },
    {
      id: "gpt-5.6-sol",
      compat: undefined,
      key: "session-123",
      lifetime: { prompt_cache_options: { ttl: "30m" } },
    },
    { id: "gpt-5.4", compat: { supportsPromptCacheKey: false }, key: undefined, lifetime: {} },
  ])("uses native cache policy for $id with $compat", async ({ id, compat, key, lifetime }) => {
    const model = {
      id,
      name: id,
      api: "openai-completions",
      provider: "openai",
      baseUrl: "https://api.openai.com/v1",
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128_000,
      maxTokens: 4096,
      compat,
    } satisfies Model<"openai-completions">;
    let payload: unknown;
    const result = await streamOpenAICompletions(
      model,
      { messages: [{ role: "user", content: "Synthetic request", timestamp: 1 }] },
      {
        apiKey: "synthetic-unused-key",
        sessionId: "session-123",
        cacheRetention: "long",
        onPayload(value) {
          payload = value;
          throw new Error("captured before request");
        },
      },
    ).result();
    expect(result.errorMessage).toBe("captured before request");
    expect(payload).toMatchObject({ prompt_cache_key: key, ...lifetime });
    if (!("prompt_cache_retention" in lifetime)) {
      expect(payload).not.toHaveProperty("prompt_cache_retention");
    }
  });
});
