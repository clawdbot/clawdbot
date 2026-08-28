import { describe, expect, it } from "vitest";
import type { Context, Model } from "../types.js";
import { streamOpenAICompletions } from "./openai-completions.js";

// Live coverage for provider compat behavior that unit fakes cannot prove:
// role selection and thinking parameters are validated by the real backends.
const LIVE = process.env.OPENCLAW_LIVE_TEST === "1";
const LIVE_TIMEOUT_MS = 120_000;

function liveModel(overrides: Partial<Model<"openai-completions">>) {
  return {
    id: "gpt-5.6-luna",
    name: "live model",
    api: "openai-completions",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128_000,
    maxTokens: 8192,
    ...overrides,
  } satisfies Model<"openai-completions">;
}

const context: Context = {
  systemPrompt: "You are terse.",
  messages: [{ role: "user", content: "Reply with exactly: OK", timestamp: 0 }],
};

async function expectLiveReply(model: Model<"openai-completions">, apiKey: string) {
  const result = await streamOpenAICompletions(model, context, {
    apiKey,
    maxTokens: 512,
  }).result();

  expect(result.errorMessage).toBeUndefined();
  expect(result.stopReason).toBe("stop");
  const text = result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("");
  expect(text.length).toBeGreaterThan(0);
  expect(result.usage.output).toBeGreaterThan(0);
  return result;
}

const OPENAI_KEY = process.env.OPENAI_API_KEY ?? "";
(LIVE && OPENAI_KEY ? describe : describe.skip)("OpenAI completions live", () => {
  it(
    "streams a completion with usage and no hidden retry stalls",
    async () => {
      await expectLiveReply(liveModel({}), OPENAI_KEY);
    },
    LIVE_TIMEOUT_MS,
  );
});

const OPENROUTER_KEY = process.env.OPENROUTER_API_KEY ?? "";
(LIVE && OPENROUTER_KEY ? describe : describe.skip)("OpenRouter completions live", () => {
  it(
    "accepts a system prompt on a model family without developer-role support",
    async () => {
      // Non-OpenAI/Anthropic model ids reject the developer role; this proves
      // the system-role selection end to end against the real gateway.
      await expectLiveReply(
        liveModel({
          id: process.env.OPENCLAW_LIVE_OPENROUTER_MODEL || "moonshotai/kimi-k2",
          provider: "openrouter",
          baseUrl: "https://openrouter.ai/api/v1",
        }),
        OPENROUTER_KEY,
      );
    },
    LIVE_TIMEOUT_MS,
  );
});

const ZAI_KEY = process.env.ZAI_API_KEY ?? "";
(LIVE && ZAI_KEY ? describe : describe.skip)("Z.AI completions live", () => {
  it(
    "streams with thinking enabled and retention opted in",
    async () => {
      const result = await streamOpenAICompletions(
        liveModel({
          id: "glm-5.1",
          provider: "zai",
          baseUrl: "https://api.z.ai/api/paas/v4",
          reasoning: true,
        }),
        context,
        {
          apiKey: ZAI_KEY,
          maxTokens: 1024,
          reasoningEffort: "low",
        },
      ).result();

      expect(result.errorMessage).toBeUndefined();
      expect(result.stopReason).toBe("stop");
      expect(result.usage.output).toBeGreaterThan(0);
    },
    LIVE_TIMEOUT_MS,
  );
});
