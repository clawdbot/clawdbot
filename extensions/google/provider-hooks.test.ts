import { createCapturedThinkingConfigStream } from "openclaw/plugin-sdk/provider-test-contracts";
import { describe, expect, it } from "vitest";
import { GOOGLE_GEMINI_PROVIDER_HOOKS } from "./provider-hooks.js";

describe("GOOGLE_GEMINI_PROVIDER_HOOKS.wrapStreamFn", () => {
  it.each([
    {
      label: "direct Gemma",
      api: "google-generative-ai",
      provider: "google",
      modelId: "gemma-4-26b-a4b-it",
      thinkingLevel: "high",
      expected: { thinkingLevel: "HIGH" },
    },
    {
      label: "provider-qualified Gemma",
      api: "google-generative-ai",
      provider: "google",
      modelId: "google/gemma-4-26b-a4b-it",
      thinkingLevel: "high",
      expected: { thinkingLevel: "HIGH" },
    },
    {
      label: "resource-qualified Gemma",
      api: "google-generative-ai",
      provider: "google",
      modelId: "models/gemma-4-26b-a4b-it",
      thinkingLevel: "high",
      expected: { thinkingLevel: "HIGH" },
    },
    {
      label: "Vertex Gemma",
      api: "google-vertex",
      provider: "google-vertex",
      modelId: "gemma-4-26b-a4b-it",
      thinkingLevel: "low",
      expected: { thinkingLevel: "MINIMAL" },
    },
    {
      label: "disabled Vertex Gemma",
      api: "google-vertex",
      provider: "google-vertex",
      modelId: "gemma-4-26b-a4b-it",
      thinkingLevel: "off",
      expected: undefined,
    },
    {
      label: "adaptive Vertex Gemini 2.5",
      api: "google-vertex",
      provider: "google-vertex",
      modelId: "gemini-2.5-flash",
      thinkingLevel: "adaptive",
      expected: { thinkingBudget: -1 },
    },
    {
      label: "adaptive Vertex Gemini 3",
      api: "google-vertex",
      provider: "google-vertex",
      modelId: "gemini-3-flash-preview",
      thinkingLevel: "adaptive",
      expected: undefined,
    },
    {
      label: "Gemini CLI native Google transport",
      api: "google-generative-ai",
      provider: "google-gemini-cli",
      modelId: "gemini-3-pro-preview",
      thinkingLevel: "high",
      expected: { thinkingLevel: "HIGH" },
    },
    {
      label: "unrelated transport",
      api: "openai-completions",
      provider: "other",
      modelId: "gemma-4-26b-a4b-it",
      thinkingLevel: "high",
      expected: { thinkingBudget: -1 },
    },
  ] as const)("normalizes $label", ({ api, provider, modelId, thinkingLevel, expected }) => {
    const capture = createCapturedThinkingConfigStream();
    const wrapped = GOOGLE_GEMINI_PROVIDER_HOOKS.wrapStreamFn({
      provider,
      modelId,
      thinkingLevel,
      streamFn: capture.streamFn,
    });

    void wrapped({ api, provider, id: modelId } as never, { messages: [] } as never, {});

    const capturedConfig = capture.getCapturedPayload()?.config as
      | { thinkingConfig?: unknown }
      | undefined;
    expect(capturedConfig?.thinkingConfig).toEqual(expected);
  });
});

describe("GOOGLE_GEMINI_PROVIDER_HOOKS.classifyFailoverReason", () => {
  it.each([
    { provider: "google", code: "UNAVAILABLE", expected: "overloaded" },
    { provider: "google-vertex", code: "DEADLINE_EXCEEDED", expected: "timeout" },
    { provider: "google-antigravity", code: "INTERNAL", expected: "server_error" },
    { provider: "google-gemini-cli", code: "UNAVAILABLE", expected: "overloaded" },
  ] as const)("classifies $provider $code as $expected", ({ provider, code, expected }) => {
    expect(
      GOOGLE_GEMINI_PROVIDER_HOOKS.classifyFailoverReason({
        provider,
        errorMessage: "",
        code,
      }),
    ).toBe(expected);
  });

  it("leaves unknown codes for generic classification", () => {
    expect(
      GOOGLE_GEMINI_PROVIDER_HOOKS.classifyFailoverReason({
        provider: "google-vertex",
        errorMessage: "",
        code: "INSUFFICIENT_QUOTA",
      }),
    ).toBeUndefined();
  });
});
