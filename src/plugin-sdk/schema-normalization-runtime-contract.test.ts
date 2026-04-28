import {
  createNativeOpenAICodexResponsesModel,
  createNativeOpenAIResponsesModel,
  createParameterFreeTool,
  createPermissiveTool,
  createProxyOpenAIResponsesModel,
  normalizedParameterFreeSchema,
} from "openclaw/plugin-sdk/agent-runtime-test-contracts";
import { describe, expect, it } from "vitest";
import { buildProviderToolCompatFamilyHooks } from "./provider-tools.js";

describe("OpenAI-family schema normalization runtime contract", () => {
  const hooks = buildProviderToolCompatFamilyHooks("openai");

  it("normalizes parameter-free schemas for native OpenAI Responses tools", () => {
    const normalized = hooks.normalizeToolSchemas({
      provider: "openai",
      modelId: "gpt-5.4",
      modelApi: "openai-responses",
      model: createNativeOpenAIResponsesModel() as never,
      tools: [createParameterFreeTool()] as never,
    });

    expect(normalized[0]?.parameters).toEqual(normalizedParameterFreeSchema());
  });

  it("normalizes parameter-free schemas for native OpenAI Codex Responses tools", () => {
    const normalized = hooks.normalizeToolSchemas({
      provider: "openai-codex",
      modelId: "gpt-5.4",
      modelApi: "openai-codex-responses",
      model: createNativeOpenAICodexResponsesModel() as never,
      tools: [createParameterFreeTool()] as never,
    });

    expect(normalized[0]?.parameters).toEqual(normalizedParameterFreeSchema());
  });

  it("does not apply native strict normalization to proxy-like OpenAI routes", () => {
    const tools = [createParameterFreeTool()] as never;
    const normalized = hooks.normalizeToolSchemas({
      provider: "openai",
      modelId: "custom-gpt",
      modelApi: "openai-responses",
      model: createProxyOpenAIResponsesModel() as never,
      tools,
    });

    expect(normalized).toBe(tools);
  });

  it("keeps permissive schemas observable for transport strict:false downgrade", () => {
    const tool = createPermissiveTool();
    const normalized = hooks.normalizeToolSchemas({
      provider: "openai-codex",
      modelId: "gpt-5.4",
      modelApi: "openai-codex-responses",
      model: createNativeOpenAICodexResponsesModel() as never,
      tools: [tool] as never,
    });

    expect(normalized[0]?.parameters).toEqual(tool.parameters);
    expect(
      hooks.inspectToolSchemas({
        provider: "openai-codex",
        modelId: "gpt-5.4",
        modelApi: "openai-codex-responses",
        model: createNativeOpenAICodexResponsesModel() as never,
        tools: [tool] as never,
      }),
    ).toEqual([]);
  });
});
