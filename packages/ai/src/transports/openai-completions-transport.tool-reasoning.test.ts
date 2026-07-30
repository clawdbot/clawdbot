// Covers the GPT-5.5/5.6 tool-reasoning endpoint gating: OpenAI-only reasoning
// controls must not fire for non-OpenAI deployments on multi-model Azure
// Foundry hosts whose operator-chosen deployment id merely looks like an
// OpenAI model.
import type { Context, Model } from "@openclaw/llm-core";
import { describe, expect, it } from "vitest";
import { buildOpenAICompletionsParams } from "./openai-completions-transport.js";

const baseModel = {
  id: "gpt-5.6-luna",
  name: "GPT-5.6 Luna (Azure)",
  api: "openai-completions",
  provider: "azure-openai",
  baseUrl: "https://example.services.ai.azure.com/openai/v1",
  reasoning: false,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128_000,
  maxTokens: 4096,
} satisfies Model<"openai-completions">;

const toolContext = {
  messages: [{ role: "user", content: "hi", timestamp: 1 }],
  tools: [{ name: "lookup", description: "Lookup", parameters: {} }],
} as unknown as Context;

describe("buildOpenAICompletionsParams tool-reasoning endpoint gating", () => {
  it("disables tool reasoning for OpenAI-family GPT-5.6 deployments on Azure Foundry hosts", () => {
    const model = {
      ...baseModel,
      id: "prod-luna",
      baseUrl: "https://eastus.api.cognitive.microsoft.com/openai/v1",
    } satisfies Model<"openai-completions">;

    const params = buildOpenAICompletionsParams(model, toolContext, undefined);

    expect(params).toMatchObject({ reasoning_effort: "none" });
  });

  it("keeps reasoning untouched for non-OpenAI Foundry deployments despite a gpt-like alias id", () => {
    const model = {
      ...baseModel,
      id: "gpt-5.6-prod",
      name: "Llama 3.1 405B Instruct",
      baseUrl: "https://eastus.api.cognitive.microsoft.com/openai/v1",
    } satisfies Model<"openai-completions">;

    const params = buildOpenAICompletionsParams(model, toolContext, undefined);

    expect(params).not.toHaveProperty("reasoning_effort");
  });

  it("still disables tool reasoning for GPT-5.6 alias ids on dedicated Azure OpenAI hosts", () => {
    const model = {
      ...baseModel,
      id: "gpt-5.6-prod",
      name: "Company Deployment",
      baseUrl: "https://example.cognitiveservices.azure.com/openai/v1",
    } satisfies Model<"openai-completions">;

    const params = buildOpenAICompletionsParams(model, toolContext, undefined);

    expect(params).toMatchObject({ reasoning_effort: "none" });
  });

  it("keeps the requested effort for non-OpenAI Foundry deployments with a gpt-5.5 alias id", () => {
    const model = {
      ...baseModel,
      id: "gpt-5.5-prod",
      name: "Llama 3.1 405B Instruct",
      reasoning: true,
      compat: { supportsReasoningEffort: true },
    } satisfies Model<"openai-completions">;

    const params = buildOpenAICompletionsParams(model, toolContext, {
      reasoningEffort: "low",
    });

    expect(params).toMatchObject({ reasoning_effort: "low" });
  });

  it("omits the requested effort for OpenAI-family GPT-5.5 deployments on Foundry hosts", () => {
    const model = {
      ...baseModel,
      id: "prod-spud",
      name: "GPT-5.5 (Azure)",
      reasoning: true,
      compat: { supportsReasoningEffort: true },
    } satisfies Model<"openai-completions">;

    const params = buildOpenAICompletionsParams(model, toolContext, {
      reasoningEffort: "low",
    });

    expect(params).not.toHaveProperty("reasoning_effort");
  });
});
