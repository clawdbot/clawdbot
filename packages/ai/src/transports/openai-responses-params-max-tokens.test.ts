import type { Context, Model } from "@openclaw/llm-core";
import { describe, expect, it } from "vitest";
import {
  buildOpenAIResponsesParams,
  sanitizeOpenAICodexResponsesParams,
} from "./openai-responses-params-internal.js";

const context = {
  messages: [{ role: "user", content: "hello", timestamp: 0 }],
} satisfies Context;

function responsesModel(overrides: Partial<Model<"openai-responses">> = {}) {
  return {
    id: "gpt-5.6-luna",
    name: "GPT-5.6 Luna",
    api: "openai-responses",
    provider: "openai",
    baseUrl: "https://api.openai.com/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 200_000,
    maxTokens: 4_096,
    ...overrides,
  } satisfies Model<"openai-responses">;
}

describe("buildOpenAIResponsesParams max_output_tokens capacity clamp", () => {
  it("preserves a request below the model cap", () => {
    const params = buildOpenAIResponsesParams(responsesModel(), context, { maxTokens: 2_048 });
    expect(params.max_output_tokens).toBe(2_048);
  });

  it("clamps an oversized request to the model cap", () => {
    const params = buildOpenAIResponsesParams(responsesModel(), context, {
      maxTokens: 200_000,
    });
    expect(params.max_output_tokens).toBe(4_096);
  });

  it("keeps undefined and zero fallback semantics on the model cap", () => {
    expect(buildOpenAIResponsesParams(responsesModel(), context, {}).max_output_tokens).toBe(4_096);
    expect(
      buildOpenAIResponsesParams(responsesModel(), context, { maxTokens: 0 }).max_output_tokens,
    ).toBe(4_096);
  });

  it("clamps the same oversized request for Azure Responses models", () => {
    const azureModel = responsesModel({
      id: "gpt-5.6-luna",
      provider: "azure-openai-responses",
      baseUrl: "https://account.openai.azure.com/openai/v1",
    });
    const params = buildOpenAIResponsesParams(azureModel, context, { maxTokens: 100_000 });
    expect(params.max_output_tokens).toBe(4_096);
  });

  it("keeps Codex Responses stripping unsupported fields after clamping", () => {
    const codexModel = responsesModel({
      id: "gpt-5.6-codex",
      api: "openai-chatgpt-responses",
      provider: "openai",
      baseUrl: "https://chatgpt.com/backend-api/codex",
    });
    const built = buildOpenAIResponsesParams(codexModel, context, { maxTokens: 200_000 });
    const params = sanitizeOpenAICodexResponsesParams(
      codexModel,
      built as unknown as Record<string, unknown>,
    );
    expect(params.max_output_tokens).toBeUndefined();
    expect(Object.hasOwn(params, "max_output_tokens")).toBe(false);
  });
});
