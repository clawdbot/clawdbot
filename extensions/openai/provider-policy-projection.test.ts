import type { ProviderNormalizeResolvedModelContext } from "openclaw/plugin-sdk/plugin-entry";
import type { ModelApi } from "openclaw/plugin-sdk/provider-model-types";
import { describe, expect, it } from "vitest";
import { projectConfiguredModelRow } from "./provider-policy-api.js";

function createProjectionContext(params?: {
  modelId?: string;
  rowApi?: ModelApi;
  rowBaseUrl?: string;
  providerApi?: ModelApi;
  configuredModelApi?: ModelApi;
}): ProviderNormalizeResolvedModelContext {
  const modelId = params?.modelId ?? "gpt-5.5";
  return {
    provider: "openai",
    modelId,
    ...(params?.providerApi
      ? {
          config: {
            models: {
              providers: {
                openai: {
                  api: params.providerApi,
                  baseUrl: "https://api.openai.com/v1",
                  models: [
                    {
                      id: modelId,
                      name: "Configured OpenAI model",
                      reasoning: true,
                      input: ["text" as const],
                      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                      contextWindow: 96_000,
                      maxTokens: 128_000,
                      ...(params.configuredModelApi ? { api: params.configuredModelApi } : {}),
                    },
                  ],
                },
              },
            },
          },
        }
      : {}),
    model: {
      provider: "openai",
      id: modelId,
      api: params?.rowApi ?? ("openai-responses" as const),
      baseUrl: params?.rowBaseUrl ?? "https://api.openai.com/v1",
      input: ["text" as const],
      name: "OpenAI model",
      reasoning: true,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 96_000,
      maxTokens: 128_000,
    },
  };
}

describe("OpenAI configured-row projection", () => {
  it("skips runtime normalization for canonical Responses rows", () => {
    expect(projectConfiguredModelRow(createProjectionContext())).toBeNull();
  });

  it.each([
    {
      source: "provider",
      providerApi: "openai-completions" as const,
      configuredModelApi: undefined,
      rowApi: undefined,
    },
    {
      source: "model",
      providerApi: "openai-responses" as const,
      configuredModelApi: "openai-completions" as const,
      rowApi: "openai-completions" as const,
    },
    {
      source: "provider ChatGPT",
      providerApi: "openai-chatgpt-responses" as const,
      configuredModelApi: undefined,
      rowApi: undefined,
    },
  ])(
    "keeps runtime normalization for a $source configured route",
    ({ providerApi, configuredModelApi, rowApi }) => {
      expect(
        projectConfiguredModelRow(
          createProjectionContext({ providerApi, configuredModelApi, rowApi }),
        ),
      ).toBeUndefined();
    },
  );

  it.each([
    ["openai-completions", "https://api.openai.com/v1", "gpt-5.5"],
    ["openai-chatgpt-responses", "https://chatgpt.com/backend-api/codex", "gpt-5.5"],
    ["openai-responses", "https://chatgpt.com/backend-api/codex", "gpt-5.5"],
    ["anthropic-messages", "https://api.openai.com/v1", "gpt-5.5"],
    ["openai-responses", "https://api.openai.com/v1", "gpt-5.4-codex"],
  ] as const)(
    "keeps runtime normalization for api=%s baseUrl=%s model=%s",
    (rowApi, rowBaseUrl, modelId) => {
      expect(
        projectConfiguredModelRow(createProjectionContext({ modelId, rowApi, rowBaseUrl })),
      ).toBeUndefined();
    },
  );
});
