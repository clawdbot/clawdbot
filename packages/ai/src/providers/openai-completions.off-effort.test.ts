import { describe, expect, it } from "vitest";
import type { Context, Model } from "../types.js";
import { streamOpenAICompletions, type OpenAICompletionsOptions } from "./openai-completions.js";

const context: Context = {
  messages: [{ role: "user", content: "Synthetic request", timestamp: 1 }],
};

async function capturePayload(
  compat: Model<"openai-completions">["compat"],
  off: string | null | undefined,
  reasoningEffort?: OpenAICompletionsOptions["reasoningEffort"],
) {
  let payload: unknown;
  const result = await streamOpenAICompletions(
    {
      id: "mapped-thinking-model",
      name: "Mapped thinking model",
      provider: "synthetic-provider",
      api: "openai-completions",
      baseUrl: "https://provider.example/v1",
      reasoning: true,
      input: ["text"],
      contextWindow: 32_000,
      maxTokens: 1024,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      thinkingLevelMap: off === undefined ? undefined : { off },
      compat,
    },
    context,
    {
      apiKey: "synthetic-unused-key",
      reasoningEffort,
      onPayload(value) {
        payload = value;
        throw new Error("captured before network");
      },
    },
  ).result();
  expect(result.errorMessage).toBe("captured before network");
  return payload;
}

describe("mapped off effort in chat completions", () => {
  it.each([
    { thinkingFormat: "zai", expected: { thinking: { type: "enabled", clear_thinking: false } } },
    { thinkingFormat: "qwen", expected: { enable_thinking: true } },
    {
      thinkingFormat: "qwen-chat-template",
      expected: { chat_template_kwargs: { enable_thinking: true, preserve_thinking: true } },
    },
    {
      thinkingFormat: "deepseek",
      expected: { thinking: { type: "enabled" }, reasoning_effort: "low" },
    },
    { thinkingFormat: "openrouter", expected: { reasoning: { effort: "low" } } },
    {
      thinkingFormat: "together",
      expected: { reasoning: { enabled: true }, reasoning_effort: "low" },
    },
    { thinkingFormat: "openai", expected: { reasoning_effort: "low" } },
  ] as const)(
    "honors the model's off mapping for $thinkingFormat",
    async ({ thinkingFormat, expected }) => {
      expect(
        await capturePayload({ thinkingFormat, supportsReasoningEffort: true }, "low"),
      ).toMatchObject(expected);
    },
  );

  it.each([undefined, null, "none"])(
    "keeps Z.AI disabled for an unmapped or disabled off level: %s",
    async (off) => {
      expect(await capturePayload({ thinkingFormat: "zai" }, off)).toMatchObject({
        thinking: { type: "disabled" },
      });
    },
  );

  it("preserves an explicit none effort over the mapped default", async () => {
    expect(await capturePayload({ thinkingFormat: "zai" }, "low", "none")).toMatchObject({
      thinking: { type: "disabled" },
    });
  });

  it("gives provider compatibility metadata precedence over the model map", async () => {
    expect(
      await capturePayload({ thinkingFormat: "zai", reasoningEffortMap: { off: "low" } }, "none"),
    ).toMatchObject({ thinking: { type: "enabled", clear_thinking: false } });
  });
});
