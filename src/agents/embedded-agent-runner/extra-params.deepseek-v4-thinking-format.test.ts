import { beforeEach, describe, expect, it, vi } from "vitest";
import { createLlmStreamSimpleMock } from "../../../test/helpers/agents/llm-stream-simple-mock.js";
import type { ModelCompatConfig } from "../../config/types.models.js";
import type { Model } from "../../llm/types.js";

vi.mock("../../llm/stream.js", () => createLlmStreamSimpleMock());

let runExtraParamsCase: typeof import("./extra-params.test-support.js").runExtraParamsCase;

function runDeepSeekV4Case(params: {
  messages?: Array<Record<string, unknown>>;
  payloadExtras?: Record<string, unknown>;
  provider?: string;
  thinkingFormat?: ModelCompatConfig["thinkingFormat"];
  thinkingLevel?: "off" | "high";
}): Record<string, unknown> {
  const provider = params.provider ?? "opencode";
  const compat = params.thinkingFormat ? { thinkingFormat: params.thinkingFormat } : undefined;
  return runExtraParamsCase({
    applyProvider: provider,
    applyModelId: "DeepSeek-V4-Flash",
    mockProviderRuntime: true,
    thinkingLevel: params.thinkingLevel ?? "high",
    model: {
      api: "openai-completions",
      provider,
      id: "DeepSeek-V4-Flash",
      ...(compat ? { compat } : {}),
    } as Model<"openai-completions">,
    payload: {
      model: "DeepSeek-V4-Flash",
      messages: params.messages ?? [],
      ...params.payloadExtras,
    },
  }).payload as Record<string, unknown>;
}

describe("extra-params: DeepSeek V4 OpenAI-compatible thinking fallback", () => {
  beforeEach(async () => {
    ({ runExtraParamsCase } = await import("./extra-params.test-support.js"));
  });

  it("injects deepseek-native thinking for unowned proxy providers", () => {
    const payload = runDeepSeekV4Case({ thinkingLevel: "high" });
    expect(payload.thinking).toEqual({ type: "enabled" });
    expect(payload.reasoning_effort).toBe("high");
  });

  it("does not inject thinking on canonical Microsoft Foundry", () => {
    const payload = runDeepSeekV4Case({
      provider: "microsoft-foundry",
      thinkingLevel: "high",
    });
    expect(payload).not.toHaveProperty("thinking");
    expect(payload).not.toHaveProperty("reasoning_effort");
  });

  it("does not inject thinking on Microsoft Foundry alias providers", () => {
    const payload = runDeepSeekV4Case({
      messages: [
        { role: "user", content: "continue" },
        { role: "assistant", content: "prior", reasoning_content: "native reasoning" },
      ],
      provider: "microsoft-foundry-9433",
      thinkingLevel: "high",
    });
    expect(payload).not.toHaveProperty("thinking");
    expect(payload).not.toHaveProperty("reasoning_effort");
    expect((payload.messages as Array<Record<string, unknown>>)[1]).not.toHaveProperty(
      "reasoning_content",
    );
  });

  it("does not inject thinking when thinkingFormat is openai (Azure Foundry)", () => {
    const payload = runDeepSeekV4Case({ thinkingFormat: "openai", thinkingLevel: "high" });
    expect(payload).not.toHaveProperty("thinking");
    expect(payload).not.toHaveProperty("reasoning_effort");
  });

  it("strips DeepSeek replay fields when thinkingFormat is openai", () => {
    const payload = runDeepSeekV4Case({
      messages: [
        { role: "user", content: "continue" },
        { role: "assistant", content: "prior", reasoning_content: "native reasoning" },
      ],
      thinkingFormat: "openai",
      thinkingLevel: "high",
    });
    expect((payload.messages as Array<Record<string, unknown>>)[1]).not.toHaveProperty(
      "reasoning_content",
    );
  });

  it("preserves non-DeepSeek reasoning controls while stripping replay fields", () => {
    const payload = runDeepSeekV4Case({
      messages: [
        { role: "user", content: "continue" },
        { role: "assistant", content: "prior", reasoning_content: "native reasoning" },
      ],
      payloadExtras: { reasoning: { effort: "high" } },
      thinkingFormat: "openrouter",
      thinkingLevel: "high",
    });
    expect(payload.reasoning).toEqual({ effort: "high" });
    expect((payload.messages as Array<Record<string, unknown>>)[1]).not.toHaveProperty(
      "reasoning_content",
    );
  });

  it("does not inject thinking:disabled when thinkingFormat is openai and thinking is off", () => {
    // Even `thinking: { type: "disabled" }` is rejected by Azure Foundry, so the
    // override must suppress the parameter entirely, not just disable it.
    const payload = runDeepSeekV4Case({ thinkingFormat: "openai", thinkingLevel: "off" });
    expect(payload).not.toHaveProperty("thinking");
  });

  it("keeps deepseek-native thinking when thinkingFormat is explicitly deepseek", () => {
    const payload = runDeepSeekV4Case({ thinkingFormat: "deepseek", thinkingLevel: "high" });
    expect(payload.thinking).toEqual({ type: "enabled" });
    expect(payload.reasoning_effort).toBe("high");
  });
});
