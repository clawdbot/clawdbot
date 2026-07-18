import { describe, expect, it } from "vitest";
import { configureAiTransportHost } from "../host.js";
import type { Context, Model } from "../types.js";
import { streamSimpleAzureOpenAIResponses, testing } from "./azure-openai-responses.js";

const azureResponsesModel = {
  id: "gpt-5.5",
  name: "GPT-5.5",
  api: "azure-openai-responses",
  provider: "azure",
  baseUrl: "https://example.openai.azure.com/openai/v1",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 200000,
  maxTokens: 8192,
} satisfies Model<"azure-openai-responses">;

const context = {
  messages: [{ role: "user", content: "hello", timestamp: 1 }],
} satisfies Context;

describe("azure-openai-responses", () => {
  it("keeps traditional Azure OpenAI hosts on the AzureOpenAI client path", () => {
    const config = testing.resolveAzureConfig(azureResponsesModel, {
      azureResourceName: "example",
      azureApiVersion: "v1",
    });

    expect(config).toEqual({
      baseUrl: "https://example.openai.azure.com/openai/v1",
      apiVersion: "v1",
    });
    expect(testing.isOpenAICompatibleAzureResponsesBaseUrl(config.baseUrl)).toBe(false);
    expect(
      testing.isOpenAICompatibleAzureResponsesBaseUrl(
        "https://example.cognitiveservices.azure.com/openai/v1",
      ),
    ).toBe(false);
  });

  it("uses the OpenAI-compatible client path for Foundry /openai/v1 endpoints", () => {
    expect(
      testing.isOpenAICompatibleAzureResponsesBaseUrl(
        "https://project.services.ai.azure.com/api/projects/demo/openai/v1",
      ),
    ).toBe(true);
    expect(
      testing.isOpenAICompatibleAzureResponsesBaseUrl(
        "https://project.services.ai.azure.com/openai/v1",
      ),
    ).toBe(true);
    expect(
      testing.isOpenAICompatibleAzureResponsesBaseUrl(
        "https://eastus.api.cognitive.microsoft.com/openai/v1",
      ),
    ).toBe(true);
  });

  it("does not treat non-v1 custom endpoints as OpenAI-compatible Responses bases", () => {
    expect(
      testing.isOpenAICompatibleAzureResponsesBaseUrl(
        "https://project.services.ai.azure.com/api/projects/demo",
      ),
    ).toBe(false);
  });

  it("keeps private or APIM Azure OpenAI-compatible paths on the AzureOpenAI client path", () => {
    expect(testing.isOpenAICompatibleAzureResponsesBaseUrl("https://aoai.internal/openai/v1")).toBe(
      false,
    );
    expect(
      testing.isOpenAICompatibleAzureResponsesBaseUrl(
        "https://gateway.example.com/proxy/openai/v1",
      ),
    ).toBe(false);
  });

  it("sends a case-insensitively resolved deployment name", async () => {
    const previousDeploymentMap = process.env.AZURE_OPENAI_DEPLOYMENT_NAME_MAP;
    let sentModel: unknown;
    const hostFetch: typeof fetch = async (input, init) => {
      const body = (await new Request(input, init).json()) as { model?: unknown };
      sentModel = body.model;
      return Response.json({ error: { message: "captured" } }, { status: 400 });
    };

    process.env.AZURE_OPENAI_DEPLOYMENT_NAME_MAP = "gpt-5.5=Deployment-GPT-5.5";
    configureAiTransportHost({ buildModelFetch: () => hostFetch });
    try {
      await streamSimpleAzureOpenAIResponses(
        { ...azureResponsesModel, id: "GPT-5.5", name: "GPT-5.5" },
        context,
        { apiKey: "test-key" },
      ).result();

      expect(sentModel).toBe("Deployment-GPT-5.5");
    } finally {
      configureAiTransportHost({});
      if (previousDeploymentMap === undefined) {
        delete process.env.AZURE_OPENAI_DEPLOYMENT_NAME_MAP;
      } else {
        process.env.AZURE_OPENAI_DEPLOYMENT_NAME_MAP = previousDeploymentMap;
      }
    }
  });

  it("disables response storage and clamps small output limits", async () => {
    let sentParams: { max_output_tokens?: unknown; store?: unknown } | undefined;
    const hostFetch: typeof fetch = async (input, init) => {
      sentParams = (await new Request(input, init).json()) as typeof sentParams;
      return Response.json({ error: { message: "captured" } }, { status: 400 });
    };

    configureAiTransportHost({ buildModelFetch: () => hostFetch });
    try {
      await streamSimpleAzureOpenAIResponses(azureResponsesModel, context, {
        apiKey: "test-api-key",
        maxTokens: 1,
      }).result();

      expect(sentParams).toMatchObject({ max_output_tokens: 16, store: false });
    } finally {
      configureAiTransportHost({});
    }
  });
});
