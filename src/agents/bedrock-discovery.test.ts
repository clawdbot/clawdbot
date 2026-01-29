import type { BedrockClient } from "@aws-sdk/client-bedrock";
import { beforeEach, describe, expect, it, vi } from "vitest";

const sendMock = vi.fn();
const clientFactory = () => ({ send: sendMock }) as unknown as BedrockClient;

describe("bedrock discovery", () => {
  beforeEach(() => {
    sendMock.mockReset();
  });

  it("filters to active streaming text models and maps modalities", async () => {
    const { discoverBedrockModels, resetBedrockDiscoveryCacheForTest } =
      await import("./bedrock-discovery.js");
    resetBedrockDiscoveryCacheForTest();

    // Mock ListFoundationModelsCommand response
    sendMock.mockResolvedValueOnce({
      modelSummaries: [
        {
          modelId: "anthropic.claude-3-7-sonnet-20250219-v1:0",
          modelName: "Claude 3.7 Sonnet",
          providerName: "anthropic",
          inputModalities: ["TEXT", "IMAGE"],
          outputModalities: ["TEXT"],
          responseStreamingSupported: true,
          modelLifecycle: { status: "ACTIVE" },
        },
        {
          modelId: "anthropic.claude-3-haiku-20240307-v1:0",
          modelName: "Claude 3 Haiku",
          providerName: "anthropic",
          inputModalities: ["TEXT"],
          outputModalities: ["TEXT"],
          responseStreamingSupported: false,
          modelLifecycle: { status: "ACTIVE" },
        },
        {
          modelId: "meta.llama3-8b-instruct-v1:0",
          modelName: "Llama 3 8B",
          providerName: "meta",
          inputModalities: ["TEXT"],
          outputModalities: ["TEXT"],
          responseStreamingSupported: true,
          modelLifecycle: { status: "INACTIVE" },
        },
        {
          modelId: "amazon.titan-embed-text-v1",
          modelName: "Titan Embed",
          providerName: "amazon",
          inputModalities: ["TEXT"],
          outputModalities: ["EMBEDDING"],
          responseStreamingSupported: true,
          modelLifecycle: { status: "ACTIVE" },
        },
      ],
    });
    // Mock ListInferenceProfilesCommand response (empty)
    sendMock.mockResolvedValueOnce({ inferenceProfileSummaries: [] });

    const models = await discoverBedrockModels({ region: "us-east-1", clientFactory });
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({
      id: "anthropic.claude-3-7-sonnet-20250219-v1:0",
      name: "Claude 3.7 Sonnet",
      reasoning: false,
      input: ["text", "image"],
      contextWindow: 32000,
      maxTokens: 4096,
    });
  });

  it("applies provider filter", async () => {
    const { discoverBedrockModels, resetBedrockDiscoveryCacheForTest } =
      await import("./bedrock-discovery.js");
    resetBedrockDiscoveryCacheForTest();

    sendMock.mockResolvedValueOnce({
      modelSummaries: [
        {
          modelId: "anthropic.claude-3-7-sonnet-20250219-v1:0",
          modelName: "Claude 3.7 Sonnet",
          providerName: "anthropic",
          inputModalities: ["TEXT"],
          outputModalities: ["TEXT"],
          responseStreamingSupported: true,
          modelLifecycle: { status: "ACTIVE" },
        },
      ],
    });
    sendMock.mockResolvedValueOnce({ inferenceProfileSummaries: [] });

    const models = await discoverBedrockModels({
      region: "us-east-1",
      config: { providerFilter: ["amazon"] },
      clientFactory,
    });
    expect(models).toHaveLength(0);
  });

  it("uses configured defaults for context and max tokens", async () => {
    const { discoverBedrockModels, resetBedrockDiscoveryCacheForTest } =
      await import("./bedrock-discovery.js");
    resetBedrockDiscoveryCacheForTest();

    sendMock.mockResolvedValueOnce({
      modelSummaries: [
        {
          modelId: "anthropic.claude-3-7-sonnet-20250219-v1:0",
          modelName: "Claude 3.7 Sonnet",
          providerName: "anthropic",
          inputModalities: ["TEXT"],
          outputModalities: ["TEXT"],
          responseStreamingSupported: true,
          modelLifecycle: { status: "ACTIVE" },
        },
      ],
    });
    sendMock.mockResolvedValueOnce({ inferenceProfileSummaries: [] });

    const models = await discoverBedrockModels({
      region: "us-east-1",
      config: { defaultContextWindow: 64000, defaultMaxTokens: 8192 },
      clientFactory,
    });
    expect(models[0]).toMatchObject({ contextWindow: 64000, maxTokens: 8192 });
  });

  it("caches results when refreshInterval is enabled", async () => {
    const { discoverBedrockModels, resetBedrockDiscoveryCacheForTest } =
      await import("./bedrock-discovery.js");
    resetBedrockDiscoveryCacheForTest();

    sendMock.mockResolvedValueOnce({
      modelSummaries: [
        {
          modelId: "anthropic.claude-3-7-sonnet-20250219-v1:0",
          modelName: "Claude 3.7 Sonnet",
          providerName: "anthropic",
          inputModalities: ["TEXT"],
          outputModalities: ["TEXT"],
          responseStreamingSupported: true,
          modelLifecycle: { status: "ACTIVE" },
        },
      ],
    });
    sendMock.mockResolvedValueOnce({ inferenceProfileSummaries: [] });

    await discoverBedrockModels({ region: "us-east-1", clientFactory });
    await discoverBedrockModels({ region: "us-east-1", clientFactory });
    // 2 calls for first discovery (foundation models + inference profiles), 0 for second (cached)
    expect(sendMock).toHaveBeenCalledTimes(2);
  });

  it("skips cache when refreshInterval is 0", async () => {
    const { discoverBedrockModels, resetBedrockDiscoveryCacheForTest } =
      await import("./bedrock-discovery.js");
    resetBedrockDiscoveryCacheForTest();

    // First call - foundation models + inference profiles
    sendMock
      .mockResolvedValueOnce({
        modelSummaries: [
          {
            modelId: "anthropic.claude-3-7-sonnet-20250219-v1:0",
            modelName: "Claude 3.7 Sonnet",
            providerName: "anthropic",
            inputModalities: ["TEXT"],
            outputModalities: ["TEXT"],
            responseStreamingSupported: true,
            modelLifecycle: { status: "ACTIVE" },
          },
        ],
      })
      .mockResolvedValueOnce({ inferenceProfileSummaries: [] })
      // Second call - foundation models + inference profiles
      .mockResolvedValueOnce({
        modelSummaries: [
          {
            modelId: "anthropic.claude-3-7-sonnet-20250219-v1:0",
            modelName: "Claude 3.7 Sonnet",
            providerName: "anthropic",
            inputModalities: ["TEXT"],
            outputModalities: ["TEXT"],
            responseStreamingSupported: true,
            modelLifecycle: { status: "ACTIVE" },
          },
        ],
      })
      .mockResolvedValueOnce({ inferenceProfileSummaries: [] });

    await discoverBedrockModels({
      region: "us-east-1",
      config: { refreshInterval: 0 },
      clientFactory,
    });
    await discoverBedrockModels({
      region: "us-east-1",
      config: { refreshInterval: 0 },
      clientFactory,
    });
    // 2 calls per discovery * 2 discoveries = 4 calls
    expect(sendMock).toHaveBeenCalledTimes(4);
  });

  it("discovers inference profiles with CRIS prefixes", async () => {
    const { discoverBedrockModels, resetBedrockDiscoveryCacheForTest } =
      await import("./bedrock-discovery.js");
    resetBedrockDiscoveryCacheForTest();

    sendMock.mockResolvedValueOnce({
      modelSummaries: [
        {
          modelId: "anthropic.claude-3-7-sonnet-20250219-v1:0",
          modelName: "Claude 3.7 Sonnet",
          providerName: "anthropic",
          inputModalities: ["TEXT", "IMAGE"],
          outputModalities: ["TEXT"],
          responseStreamingSupported: true,
          modelLifecycle: { status: "ACTIVE" },
        },
      ],
    });
    sendMock.mockResolvedValueOnce({
      inferenceProfileSummaries: [
        {
          inferenceProfileId: "global.anthropic.claude-opus-4-5-20251101-v1:0",
          inferenceProfileName: "GLOBAL Anthropic Claude Opus 4.5",
          status: "ACTIVE",
          models: [
            {
              modelArn:
                "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-opus-4-5-20251101-v1:0",
            },
          ],
        },
        {
          inferenceProfileId: "eu.anthropic.claude-3-sonnet-20240229-v1:0",
          inferenceProfileName: "EU Anthropic Claude 3 Sonnet",
          status: "ACTIVE",
          models: [
            {
              modelArn:
                "arn:aws:bedrock:eu-west-1::foundation-model/anthropic.claude-3-sonnet-20240229-v1:0",
            },
          ],
        },
        {
          inferenceProfileId: "us.amazon.nova-pro-v1:0",
          inferenceProfileName: "US Amazon Nova Pro",
          status: "INACTIVE",
          models: [],
        },
      ],
    });

    const models = await discoverBedrockModels({ region: "us-east-1", clientFactory });

    // Should include 1 foundation model + 2 active inference profiles
    expect(models).toHaveLength(3);

    const foundationModel = models.find(
      (m) => m.id === "anthropic.claude-3-7-sonnet-20250219-v1:0",
    );
    expect(foundationModel).toBeDefined();

    const globalProfile = models.find(
      (m) => m.id === "global.anthropic.claude-opus-4-5-20251101-v1:0",
    );
    expect(globalProfile).toBeDefined();
    expect(globalProfile?.name).toBe("GLOBAL Anthropic Claude Opus 4.5");

    const euProfile = models.find((m) => m.id === "eu.anthropic.claude-3-sonnet-20240229-v1:0");
    expect(euProfile).toBeDefined();
    expect(euProfile?.name).toBe("EU Anthropic Claude 3 Sonnet");

    // Inactive profile should not be included
    const usProfile = models.find((m) => m.id === "us.amazon.nova-pro-v1:0");
    expect(usProfile).toBeUndefined();
  });

  it("inherits capabilities from foundation model for inference profiles", async () => {
    const { discoverBedrockModels, resetBedrockDiscoveryCacheForTest } =
      await import("./bedrock-discovery.js");
    resetBedrockDiscoveryCacheForTest();

    sendMock.mockResolvedValueOnce({
      modelSummaries: [
        {
          modelId: "anthropic.claude-3-sonnet-20240229-v1:0",
          modelName: "Claude 3 Sonnet",
          providerName: "anthropic",
          inputModalities: ["TEXT", "IMAGE"],
          outputModalities: ["TEXT"],
          responseStreamingSupported: true,
          modelLifecycle: { status: "ACTIVE" },
        },
      ],
    });
    sendMock.mockResolvedValueOnce({
      inferenceProfileSummaries: [
        {
          inferenceProfileId: "eu.anthropic.claude-3-sonnet-20240229-v1:0",
          inferenceProfileName: "EU Anthropic Claude 3 Sonnet",
          status: "ACTIVE",
          models: [
            {
              modelArn:
                "arn:aws:bedrock:eu-west-1::foundation-model/anthropic.claude-3-sonnet-20240229-v1:0",
            },
          ],
        },
      ],
    });

    const models = await discoverBedrockModels({ region: "us-east-1", clientFactory });

    const euProfile = models.find((m) => m.id === "eu.anthropic.claude-3-sonnet-20240229-v1:0");
    expect(euProfile).toBeDefined();
    // Should inherit text+image input from the foundation model
    expect(euProfile?.input).toEqual(["text", "image"]);
  });

  it("applies provider filter to inference profiles", async () => {
    const { discoverBedrockModels, resetBedrockDiscoveryCacheForTest } =
      await import("./bedrock-discovery.js");
    resetBedrockDiscoveryCacheForTest();

    sendMock.mockResolvedValueOnce({ modelSummaries: [] });
    sendMock.mockResolvedValueOnce({
      inferenceProfileSummaries: [
        {
          inferenceProfileId: "global.anthropic.claude-opus-4-5-20251101-v1:0",
          inferenceProfileName: "GLOBAL Anthropic Claude Opus 4.5",
          status: "ACTIVE",
          models: [],
        },
        {
          inferenceProfileId: "global.amazon.nova-pro-v1:0",
          inferenceProfileName: "GLOBAL Amazon Nova Pro",
          status: "ACTIVE",
          models: [],
        },
      ],
    });

    const models = await discoverBedrockModels({
      region: "us-east-1",
      config: { providerFilter: ["anthropic"] },
      clientFactory,
    });

    expect(models).toHaveLength(1);
    expect(models[0].id).toBe("global.anthropic.claude-opus-4-5-20251101-v1:0");
  });
});
