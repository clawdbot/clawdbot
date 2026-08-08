import { describe, expect, it } from "vitest";
import { configureAiTransportHost } from "../host.js";
import { buildOpenAIResponsesReplayContext } from "../transports/openai-responses-compaction-replay.js";
import type { Context, Model } from "../types.js";
import {
  streamAzureOpenAIResponses,
  streamSimpleAzureOpenAIResponses,
  testing,
} from "./azure-openai-responses.js";

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

  it("rejects a blank environment API key before sending a request", async () => {
    const previousApiKey = process.env.AZURE_OPENAI_API_KEY;
    let fetchCalled = false;
    configureAiTransportHost({
      buildModelFetch: () => async () => {
        fetchCalled = true;
        return Response.json({ error: { message: "captured" } }, { status: 400 });
      },
    });
    process.env.AZURE_OPENAI_API_KEY = "  ";
    try {
      const result = await streamAzureOpenAIResponses(
        { ...azureResponsesModel, provider: "azure-openai-responses" },
        context,
      ).result();

      expect(fetchCalled).toBe(false);
      expect(result.errorMessage).toBe(
        "Azure OpenAI API key is required. Set AZURE_OPENAI_API_KEY environment variable or pass it as an argument.",
      );
    } finally {
      configureAiTransportHost({});
      if (previousApiKey === undefined) {
        delete process.env.AZURE_OPENAI_API_KEY;
      } else {
        process.env.AZURE_OPENAI_API_KEY = previousApiKey;
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

  it("fences compaction replay by the resolved Azure endpoint", async () => {
    const routeA = "https://route-a.openai.azure.com/openai/v1";
    const routeB = "https://route-b.openai.azure.com/openai/v1";
    const sessionId = "azure-replay-session";
    const replayContext = buildOpenAIResponsesReplayContext(
      { ...azureResponsesModel, baseUrl: routeA },
      { sessionId },
    );
    if (!replayContext.baseUrlHash) {
      throw new Error("expected Azure replay route hash");
    }
    const replayMessages = {
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "earlier" }],
          api: azureResponsesModel.api,
          provider: azureResponsesModel.provider,
          model: azureResponsesModel.id,
          providerReplay: {
            v: 1,
            type: "openai-responses-compaction",
            data: "opaque-compaction-route-a",
            ...replayContext,
            baseUrlHash: replayContext.baseUrlHash,
          },
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
          },
          stopReason: "stop",
          timestamp: 1,
        },
        { role: "user", content: "continue", timestamp: 2 },
      ],
    } satisfies Context;
    const inputs: unknown[][] = [];
    configureAiTransportHost({
      buildModelFetch: () => async (input, init) => {
        const body = (await new Request(input, init).json()) as { input?: unknown[] };
        inputs.push(body.input ?? []);
        return Response.json({ error: { message: "captured" } }, { status: 400 });
      },
    });
    try {
      for (const azureBaseUrl of [routeA, routeB]) {
        await streamAzureOpenAIResponses(azureResponsesModel, replayMessages, {
          apiKey: "test-api-key",
          azureBaseUrl,
          sessionId,
        }).result();
      }
    } finally {
      configureAiTransportHost({});
    }

    expect(inputs[0]).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "compaction",
          encrypted_content: "opaque-compaction-route-a",
        }),
      ]),
    );
    expect(inputs[1]).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ type: "compaction" })]),
    );
  });
});
