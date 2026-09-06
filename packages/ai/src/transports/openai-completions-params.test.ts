import { describe, expect, it } from "vitest";
import type { Model } from "../types.js";
import { createZeroUsage } from "../usage.test-support.js";
import { buildOpenAICompletionsParams } from "./openai-completions-params.js";
import { makeCompletionsModel } from "./openai-completions.test-support.js";

function emptyContext(systemPrompt: string | undefined = "system") {
  return { systemPrompt, messages: [], tools: [] } as never;
}

describe("openai completions params", () => {
  it("uses model params max_completion_tokens for OpenAI completions before model maxTokens", () => {
    const params = buildOpenAICompletionsParams(
      {
        id: "kimi-k2.6",
        name: "Kimi K2.6",
        api: "openai-completions",
        provider: "dashscope",
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 262_144,
        maxTokens: 32_000,
        params: {
          max_completion_tokens: 64_000,
        },
      } as never,
      emptyContext(),
      undefined,
    );

    expect(params.max_completion_tokens).toBe(64_000);
    expect(params).not.toHaveProperty("max_tokens");
  });

  it("keeps runtime maxTokens ahead of model params max_completion_tokens for OpenAI completions", () => {
    const params = buildOpenAICompletionsParams(
      {
        id: "kimi-k2.6",
        name: "Kimi K2.6",
        api: "openai-completions",
        provider: "dashscope",
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 262_144,
        maxTokens: 32_000,
        params: {
          max_completion_tokens: 64_000,
        },
      } as never,
      emptyContext(),
      { maxTokens: 16_000 } as never,
    );

    expect(params.max_completion_tokens).toBe(16_000);
    expect(params).not.toHaveProperty("max_tokens");
  });

  it("clamps runtime maxTokens to the OpenAI completions model output cap", () => {
    const params = buildOpenAICompletionsParams(
      makeCompletionsModel({
        id: "mimo-v2.5-pro",
        name: "MiMo V2.5 Pro",
        provider: "xiaomi-token-plan",
        baseUrl: "https://token-plan-sgp.xiaomimimo.com/v1",
        maxTokens: 32_000,
      }),
      emptyContext(),
      { maxTokens: 200_000 } as never,
    );

    expect(params.max_completion_tokens).toBe(32_000);
    expect(params).not.toHaveProperty("max_tokens");
  });

  it("keeps zero runtime maxTokens falling back to model params for OpenAI completions", () => {
    const params = buildOpenAICompletionsParams(
      {
        id: "kimi-k2.6",
        name: "Kimi K2.6",
        api: "openai-completions",
        provider: "dashscope",
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 262_144,
        maxTokens: 32_000,
        params: {
          max_completion_tokens: 64_000,
        },
      } as never,
      emptyContext(),
      { maxTokens: 0 } as never,
    );

    expect(params.max_completion_tokens).toBe(64_000);
    expect(params).not.toHaveProperty("max_tokens");
  });

  it("uses model maxTokens with max_tokens completions compat when runtime maxTokens is omitted", () => {
    const params = buildOpenAICompletionsParams(
      {
        id: "zai-org/GLM-4.7-TEE",
        name: "GLM 4.7 TEE",
        api: "openai-completions",
        provider: "chutes",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 65_536,
      } as never,
      emptyContext(),
      undefined,
    );

    expect(params.max_tokens).toBe(65_536);
    expect(params).not.toHaveProperty("max_completion_tokens");
  });

  it("clamps max_completion_tokens to the remaining context budget for proxy-like endpoints when prompt + output would exceed contextWindow (covers #83086)", () => {
    // StepFun-style shape: large context window, max_tokens equal to context,
    // and a substantial prompt that should leave well under the context budget.
    // 200_000 ASCII chars -> estimated 62_500 input tokens (chars/4 * 1.25).
    // That leaves remaining budget of 262_144 - 62_500 - 1 = 199_643 tokens.
    const systemPrompt = "x".repeat(200_000);
    const params = buildOpenAICompletionsParams(
      makeCompletionsModel({
        id: "step-router-v1",
        name: "StepFun step-router-v1",
        provider: "stepfun-plan",
        baseUrl: "https://api.stepfun.com/v1",
        reasoning: false,
        contextWindow: 262_144,
        maxTokens: 262_144,
      }),
      emptyContext(systemPrompt),
      undefined,
    );

    expect(typeof params.max_completion_tokens).toBe("number");
    const cap = params.max_completion_tokens as number;
    const estimatedInputTokens = Math.ceil((systemPrompt.length / 4) * 1.25);
    expect(cap).toBe(262_144 - estimatedInputTokens - 1);
    expect(cap).toBeLessThan(262_144);
  });

  it("uses CJK-aware input estimates when clamping proxy-like completions output budgets", () => {
    const cjkPrompt = "你好世界".repeat(1_000);
    const params = buildOpenAICompletionsParams(
      makeCompletionsModel({
        id: "kimi-k2.6",
        name: "Kimi K2.6",
        provider: "dashscope",
        baseUrl: "https://dashscope.aliyuncs.com/compatible-mode/v1",
        reasoning: false,
        contextWindow: 10_000,
        maxTokens: 10_000,
      }),
      {
        systemPrompt: cjkPrompt,
        messages: [],
        tools: [],
      } as never,
      undefined,
    );

    // 4,000 CJK chars count as 16,000 adjusted chars, then chars/4 * 1.25.
    expect(params.max_completion_tokens).toBe(10_000 - 5_000 - 1);
  });

  it("rounds proxy-like completions input estimates after summing message content", () => {
    const messages = Array.from({ length: 4_000 }, () => ({
      role: "user",
      content: "x",
    }));
    const params = buildOpenAICompletionsParams(
      makeCompletionsModel({
        id: "qwen3-5-122b-a10b-nvfp4",
        name: "qwen3-5-122b-a10b-nvfp4",
        provider: "vllm",
        baseUrl: "http://localhost:8000/v1",
        reasoning: false,
        contextWindow: 10_000,
        maxTokens: 10_000,
      }),
      {
        systemPrompt: undefined,
        messages,
        tools: [],
      } as never,
      undefined,
    );

    expect(params.max_completion_tokens).toBe(10_000 - 1_250 - 1);
  });

  it("estimates proxy-like completions input from the final outbound messages after compat transforms", () => {
    const userText = "ok";
    const params = buildOpenAICompletionsParams(
      makeCompletionsModel({
        id: "qwen3-5-122b-a10b-nvfp4",
        name: "qwen3-5-122b-a10b-nvfp4",
        provider: "vllm",
        baseUrl: "http://localhost:8000/v1",
        reasoning: false,
        contextWindow: 10_000,
        maxTokens: 10_000,
      }),
      {
        messages: [
          { role: "user", content: userText, timestamp: 1 },
          {
            role: "assistant",
            content: [{ type: "text", text: "x".repeat(20_000) }],
            api: "openai-completions",
            provider: "vllm",
            model: "qwen3-5-122b-a10b-nvfp4",
            usage: createZeroUsage(),
            stopReason: "aborted",
            timestamp: 2,
          },
        ],
        tools: [],
      } as never,
      undefined,
    );

    const estimatedInputTokens = Math.ceil((userText.length / 4) * 1.25);
    expect(params.max_completion_tokens).toBe(10_000 - estimatedInputTokens - 1);
  });

  it("clamps proxy-like completions output budgets against contextTokens before contextWindow", () => {
    const params = buildOpenAICompletionsParams(
      {
        id: "qwen3-5-122b-a10b-nvfp4",
        name: "qwen3-5-122b-a10b-nvfp4",
        api: "openai-completions",
        provider: "vllm",
        baseUrl: "http://localhost:8000/v1",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 131_072,
        contextTokens: 4_096,
        maxTokens: 200_000,
      } as unknown as Model<"openai-completions">,
      emptyContext(),
      undefined,
    );

    expect(params.max_completion_tokens).toBe(4_096 - 2 - 1);
  });

  it("clamps max_completion_tokens for proxy-like endpoints when configured maxTokens >= contextWindow and prompt is small", () => {
    // Misconfig case: tiny prompt, but configured maxTokens still exceeds the
    // model's contextWindow. Clamp should land just under the window.
    const params = buildOpenAICompletionsParams(
      makeCompletionsModel({
        id: "qwen3-5-122b-a10b-nvfp4",
        name: "qwen3-5-122b-a10b-nvfp4",
        provider: "vllm",
        baseUrl: "http://localhost:8000/v1",
        reasoning: false,
        contextWindow: 131_072,
        maxTokens: 200_000,
      }),
      emptyContext(),
      undefined,
    );

    expect(typeof params.max_completion_tokens).toBe("number");
    const cap = params.max_completion_tokens as number;
    expect(cap).toBeLessThan(131_072);
    // Small prompt → cap is essentially contextWindow - 1 - tiny_input_estimate.
    expect(cap).toBeGreaterThanOrEqual(131_000);
  });

  it("does not clamp max_completion_tokens for proxy-like endpoints when maxTokens fits the context window", () => {
    const params = buildOpenAICompletionsParams(
      makeCompletionsModel({
        id: "qwen3-5-122b-a10b-nvfp4",
        name: "qwen3-5-122b-a10b-nvfp4",
        provider: "vllm",
        baseUrl: "http://localhost:8000/v1",
        reasoning: false,
        contextWindow: 131_072,
      }),
      emptyContext(),
      undefined,
    );

    expect(params.max_completion_tokens).toBe(8192);
  });

  it("preserves the configured maxTokens for native openai-completions endpoints even when it equals or exceeds contextWindow", () => {
    const params = buildOpenAICompletionsParams(
      makeCompletionsModel({
        id: "gpt-5.4",
        name: "GPT-5.4",
        reasoning: false,
        contextWindow: 100_000,
        maxTokens: 200_000,
      }),
      emptyContext(),
      undefined,
    );

    expect(params.max_completion_tokens).toBe(200_000);
  });
});
