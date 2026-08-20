import type { StreamFn } from "openclaw/plugin-sdk/agent-core";
import { createAssistantMessageEventStream } from "openclaw/plugin-sdk/llm";
import { registerSingleProviderPlugin } from "openclaw/plugin-sdk/plugin-test-runtime";
import { describe, expect, it, vi } from "vitest";
import openrouterPlugin from "./index.js";

async function captureProviderPayload(
  modelId: string,
  thinkingLevel: string,
  payload: Record<string, unknown>,
) {
  const provider = await registerSingleProviderPlugin(openrouterPlugin);
  const baseStreamFn = vi.fn((...args: Parameters<StreamFn>): ReturnType<StreamFn> => {
    void args[2]?.onPayload?.(payload, args[0]);
    return createAssistantMessageEventStream();
  });
  const wrapped = provider.wrapStreamFn?.({
    provider: "openrouter",
    modelId,
    thinkingLevel,
    streamFn: baseStreamFn,
  } as never);

  void wrapped?.(
    {
      provider: "openrouter",
      api: "openai-completions",
      id: modelId,
      baseUrl: "https://openrouter.ai/api/v1",
      compat: {},
    } as never,
    { messages: [] },
    {},
  );

  expect(baseStreamFn).toHaveBeenCalledOnce();
  return payload;
}

describe("OpenRouter chat owner invariants", () => {
  it.each([
    "openrouter/anthropic/claude-sonnet-5",
    "openrouter/deepseek/deepseek-v4-pro",
    "openrouter/moonshotai/kimi-k3",
    "z-ai/glm-5.2",
    "openrouter/z-ai/glm-5.2",
    "~anthropic/claude-opus-latest",
    "~moonshotai/kimi-latest",
  ])("recognizes the live upstream cacheable model reference %s", async (modelId) => {
    const provider = await registerSingleProviderPlugin(openrouterPlugin);

    expect(provider.isCacheTtlEligible?.({ provider: "openrouter", modelId } as never)).toBe(true);
  });

  it.each(["openai/gpt-5.4", "~openai/gpt-5.4", "openrouter/openai/gpt-5.4"])(
    "does not infer provider cache support for unrelated model reference %s",
    async (modelId) => {
      const provider = await registerSingleProviderPlugin(openrouterPlugin);

      expect(provider.isCacheTtlEligible?.({ provider: "openrouter", modelId } as never)).toBe(
        false,
      );
    },
  );

  it("preserves assistant prefill when the provider reasoning object disables reasoning", async () => {
    const payload = await captureProviderPayload("anthropic/claude-opus-5", "off", {
      reasoning: { enabled: false },
      messages: [
        { role: "user", content: "Return JSON." },
        { role: "assistant", content: "{" },
      ],
    });

    expect(payload.messages).toEqual([
      { role: "user", content: "Return JSON." },
      { role: "assistant", content: "{" },
    ]);
  });

  it.each(["~anthropic/claude-opus-latest", "openrouter/~anthropic/claude-opus-latest"])(
    "removes unsupported assistant prefill for reasoning model alias %s",
    async (modelId) => {
      const payload = await captureProviderPayload(modelId, "high", {
        reasoning: { effort: "high" },
        messages: [
          { role: "user", content: "Continue." },
          { role: "assistant", content: "{" },
        ],
      });

      expect(payload.messages).toEqual([{ role: "user", content: "Continue." }]);
    },
  );

  it("recognizes the live dated DeepSeek V4 model in its owner thinking profile", async () => {
    const provider = await registerSingleProviderPlugin(openrouterPlugin);

    expect(
      provider.resolveThinkingProfile?.({
        provider: "openrouter",
        modelId: "deepseek/deepseek-v4-flash-0731",
      } as never),
    ).toMatchObject({ defaultLevel: "high" });
  });

  it("backfills reasoning replay for the live dated DeepSeek V4 model", async () => {
    const payload = await captureProviderPayload("deepseek/deepseek-v4-flash-0731", "high", {
      messages: [{ role: "assistant", content: "done" }],
    });

    expect(payload.reasoning).toEqual({ effort: "high" });
    expect(payload.messages).toEqual([
      { role: "assistant", content: "done", reasoning_content: "" },
    ]);
  });
});
