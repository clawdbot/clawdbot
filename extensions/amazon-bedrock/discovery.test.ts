import type { BedrockClient } from "@aws-sdk/client-bedrock";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  discoverBedrockModels,
  mergeImplicitBedrockProvider,
  resetBedrockDiscoveryCacheForTest,
  resolveBedrockConfigApiKey,
  resolveImplicitBedrockProvider,
} from "./api.js";

const sendMock = vi.fn();
const clientFactory = () => ({ send: sendMock }) as unknown as BedrockClient;

const baseActiveAnthropicSummary = {
  modelId: "anthropic.claude-3-7-sonnet-20250219-v1:0",
  modelName: "Claude 3.7 Sonnet",
  providerName: "anthropic",
  inputModalities: ["TEXT"],
  outputModalities: ["TEXT"],
  responseStreamingSupported: true,
  modelLifecycle: { status: "ACTIVE" },
};

function mockSingleActiveSummary(overrides: Partial<typeof baseActiveAnthropicSummary> = {}): void {
  sendMock
    .mockResolvedValueOnce({
      modelSummaries: [{ ...baseActiveAnthropicSummary, ...overrides }],
    })
    // ListInferenceProfiles response (empty — no inference profiles in basic tests).
    .mockResolvedValueOnce({ inferenceProfileSummaries: [] });
}

describe("bedrock discovery", () => {
  beforeEach(() => {
    sendMock.mockClear();
    resetBedrockDiscoveryCacheForTest();
  });

  afterEach(() => {
    resetBedrockDiscoveryCacheForTest();
  });

  it("filters to active streaming text models and maps modalities", async () => {
    sendMock
      .mockResolvedValueOnce({
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
      })
      .mockResolvedValueOnce({ inferenceProfileSummaries: [] });

    const models = await discoverBedrockModels({ region: "us-east-1", clientFactory });
    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({
      id: "anthropic.claude-3-7-sonnet-20250219-v1:0",
      name: "Claude 3.7 Sonnet",
      reasoning: false,
      input: ["text", "image"],
      contextWindow: 200000,
      maxTokens: 4096,
    });
  });

  it("applies provider filter", async () => {
    mockSingleActiveSummary();

    const models = await discoverBedrockModels({
      region: "us-east-1",
      config: { providerFilter: ["amazon"] },
      clientFactory,
    });
    expect(models).toHaveLength(0);
  });

  it("uses configured defaults for context and max tokens", async () => {
    mockSingleActiveSummary({
      modelId: "example.unknown-text-v1:0",
      modelName: "Example Unknown Text",
      providerName: "example",
    });

    const models = await discoverBedrockModels({
      region: "us-east-1",
      config: { defaultContextWindow: 64000, defaultMaxTokens: 8192 },
      clientFactory,
    });
    expect(models[0]).toMatchObject({ contextWindow: 64000, maxTokens: 8192 });
  });

  it("keeps the conservative fallback for unknown inference profiles", async () => {
    sendMock
      .mockResolvedValueOnce({
        modelSummaries: [],
      })
      .mockResolvedValueOnce({
        inferenceProfileSummaries: [
          {
            inferenceProfileId: "jp.example.unknown-text-v1:0",
            inferenceProfileName: "JP Example Unknown Text",
            status: "ACTIVE",
            type: "SYSTEM_DEFINED",
            models: [
              {
                modelArn:
                  "arn:aws:bedrock:ap-northeast-1::foundation-model/example.unknown-text-v1:0",
              },
            ],
          },
        ],
      });

    const models = await discoverBedrockModels({ region: "ap-northeast-1", clientFactory });

    expect(models).toHaveLength(1);
    expect(models[0]).toMatchObject({
      id: "jp.example.unknown-text-v1:0",
      contextWindow: 32000,
      maxTokens: 4096,
      input: ["text"],
    });
  });

  it("normalizes region-prefixed versioned model ids when resolving context windows", async () => {
    sendMock
      .mockResolvedValueOnce({
        modelSummaries: [],
      })
      .mockResolvedValueOnce({
        inferenceProfileSummaries: [
          {
            inferenceProfileId: "jp.anthropic.claude-sonnet-4-6-v1:0",
            inferenceProfileName: "JP Claude Sonnet 4.6",
            status: "ACTIVE",
            type: "SYSTEM_DEFINED",
            models: [
              {
                modelArn:
                  "arn:aws:bedrock:ap-northeast-1::foundation-model/anthropic.claude-sonnet-4-6-v1:0",
              },
            ],
          },
        ],
      });

    const models = await discoverBedrockModels({ region: "ap-northeast-1", clientFactory });

    expect(models[0]).toMatchObject({
      id: "jp.anthropic.claude-sonnet-4-6-v1:0",
      contextWindow: 1_000_000,
    });
  });

  it("caches results when refreshInterval is enabled", async () => {
    mockSingleActiveSummary();

    await discoverBedrockModels({ region: "us-east-1", clientFactory });
    await discoverBedrockModels({ region: "us-east-1", clientFactory });
    // 2 calls on first discovery (ListFoundationModels + ListInferenceProfiles), 0 on cached second.
    expect(sendMock).toHaveBeenCalledTimes(2);
  });

  it("skips cache when refreshInterval is 0", async () => {
    sendMock
      .mockResolvedValueOnce({ modelSummaries: [baseActiveAnthropicSummary] })
      .mockResolvedValueOnce({ inferenceProfileSummaries: [] })
      .mockResolvedValueOnce({ modelSummaries: [baseActiveAnthropicSummary] })
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
    // 2 calls per discovery (ListFoundationModels + ListInferenceProfiles) × 2 runs.
    expect(sendMock).toHaveBeenCalledTimes(4);
  });

  it("resolves the Bedrock config apiKey from AWS auth env vars", () => {
    expect(
      resolveBedrockConfigApiKey({
        AWS_BEARER_TOKEN_BEDROCK: "bearer", // pragma: allowlist secret
        AWS_PROFILE: "default",
      }),
    ).toBe("AWS_BEARER_TOKEN_BEDROCK");

    // When no AWS env vars are present (e.g. instance role), no marker should be injected.
    // The aws-sdk credential chain handles auth at request time. (#49891)
    expect(resolveBedrockConfigApiKey({} as NodeJS.ProcessEnv)).toBeUndefined();

    // When AWS_PROFILE is explicitly set, it should return the marker.
    expect(resolveBedrockConfigApiKey({ AWS_PROFILE: "default" } as NodeJS.ProcessEnv)).toBe(
      "AWS_PROFILE",
    );
  });

  it("discovers inference profiles and inherits foundation model capabilities", async () => {
    sendMock
      .mockResolvedValueOnce({
        modelSummaries: [
          {
            modelId: "anthropic.claude-sonnet-4-6",
            modelName: "Claude Sonnet 4.6",
            providerName: "anthropic",
            inputModalities: ["TEXT", "IMAGE"],
            outputModalities: ["TEXT"],
            responseStreamingSupported: true,
            modelLifecycle: { status: "ACTIVE" },
          },
        ],
      })
      .mockResolvedValueOnce({
        inferenceProfileSummaries: [
          {
            inferenceProfileId: "us.anthropic.claude-sonnet-4-6",
            inferenceProfileName: "US Anthropic Claude Sonnet 4.6",
            inferenceProfileArn:
              "arn:aws:bedrock:us-east-1::inference-profile/us.anthropic.claude-sonnet-4-6",
            status: "ACTIVE",
            type: "SYSTEM_DEFINED",
            models: [
              {
                modelArn: "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-sonnet-4-6",
              },
              {
                modelArn: "arn:aws:bedrock:us-west-2::foundation-model/anthropic.claude-sonnet-4-6",
              },
            ],
          },
          {
            inferenceProfileId: "eu.anthropic.claude-sonnet-4-6",
            inferenceProfileName: "EU Anthropic Claude Sonnet 4.6",
            inferenceProfileArn:
              "arn:aws:bedrock:eu-west-1::inference-profile/eu.anthropic.claude-sonnet-4-6",
            status: "ACTIVE",
            type: "SYSTEM_DEFINED",
            models: [
              {
                modelArn: "arn:aws:bedrock:eu-west-1::foundation-model/anthropic.claude-sonnet-4-6",
              },
            ],
          },
          {
            inferenceProfileId: "global.anthropic.claude-sonnet-4-6",
            inferenceProfileName: "Global Anthropic Claude Sonnet 4.6",
            inferenceProfileArn:
              "arn:aws:bedrock:us-east-1::inference-profile/global.anthropic.claude-sonnet-4-6",
            status: "ACTIVE",
            type: "SYSTEM_DEFINED",
            models: [
              {
                modelArn: "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-sonnet-4-6",
              },
            ],
          },
          // Inactive profile should be filtered out.
          {
            inferenceProfileId: "ap.anthropic.claude-sonnet-4-6",
            inferenceProfileName: "AP Claude Sonnet 4.6",
            status: "LEGACY",
            type: "SYSTEM_DEFINED",
            models: [],
          },
        ],
      });

    const models = await discoverBedrockModels({ region: "us-east-1", clientFactory });

    // Foundation model + 3 active inference profiles = 4 models.
    expect(models).toHaveLength(4);

    // Global profiles should be sorted first (recommended for most users).
    expect(models[0]?.id).toBe("global.anthropic.claude-sonnet-4-6");

    const foundationModel = models.find((m) => m.id === "anthropic.claude-sonnet-4-6");
    const usProfile = models.find((m) => m.id === "us.anthropic.claude-sonnet-4-6");
    const euProfile = models.find((m) => m.id === "eu.anthropic.claude-sonnet-4-6");
    const globalProfile = models.find((m) => m.id === "global.anthropic.claude-sonnet-4-6");

    // Foundation model has image input.
    expect(foundationModel).toMatchObject({ input: ["text", "image"] });

    // Inference profiles inherit image input from the foundation model.
    expect(usProfile).toMatchObject({
      name: "US Anthropic Claude Sonnet 4.6",
      input: ["text", "image"],
      contextWindow: 1000000,
      maxTokens: 4096,
    });
    expect(euProfile).toMatchObject({ input: ["text", "image"] });
    expect(globalProfile).toMatchObject({ input: ["text", "image"] });

    // Inactive profile should not be present.
    expect(models.find((m) => m.id === "ap.anthropic.claude-sonnet-4-6")).toBeUndefined();
  });

  it("gracefully handles ListInferenceProfiles permission errors", async () => {
    sendMock
      .mockResolvedValueOnce({
        modelSummaries: [baseActiveAnthropicSummary],
      })
      // Simulate AccessDeniedException for ListInferenceProfiles.
      .mockRejectedValueOnce(new Error("AccessDeniedException"));

    const models = await discoverBedrockModels({ region: "us-east-1", clientFactory });
    // Foundation model should still be discovered despite profile discovery failure.
    expect(models).toHaveLength(1);
    expect(models[0]?.id).toBe("anthropic.claude-3-7-sonnet-20250219-v1:0");
  });

  it("keeps matching inference profiles when provider filters are enabled", async () => {
    sendMock
      .mockResolvedValueOnce({
        modelSummaries: [
          {
            modelId: "anthropic.claude-sonnet-4-6",
            modelName: "Claude Sonnet 4.6",
            providerName: "anthropic",
            inputModalities: ["TEXT", "IMAGE"],
            outputModalities: ["TEXT"],
            responseStreamingSupported: true,
            modelLifecycle: { status: "ACTIVE" },
          },
        ],
      })
      .mockResolvedValueOnce({
        inferenceProfileSummaries: [
          {
            inferenceProfileId: "global.anthropic.claude-sonnet-4-6",
            inferenceProfileName: "Global Anthropic Claude Sonnet 4.6",
            status: "ACTIVE",
            type: "SYSTEM_DEFINED",
            models: [
              {
                modelArn: "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-sonnet-4-6",
              },
            ],
          },
        ],
      });

    const models = await discoverBedrockModels({
      region: "us-east-1",
      config: { providerFilter: ["anthropic"] },
      clientFactory,
    });

    expect(models.map((model) => model.id)).toEqual([
      "global.anthropic.claude-sonnet-4-6",
      "anthropic.claude-sonnet-4-6",
    ]);
  });

  it("prefers backing model ARNs for application profiles with region-like ids", async () => {
    sendMock
      .mockResolvedValueOnce({
        modelSummaries: [
          {
            modelId: "anthropic.claude-sonnet-4-6",
            modelName: "Claude Sonnet 4.6",
            providerName: "anthropic",
            inputModalities: ["TEXT", "IMAGE"],
            outputModalities: ["TEXT"],
            responseStreamingSupported: true,
            modelLifecycle: { status: "ACTIVE" },
          },
        ],
      })
      .mockResolvedValueOnce({
        inferenceProfileSummaries: [
          {
            inferenceProfileId: "us.my-prod-profile",
            inferenceProfileName: "Prod Claude Profile",
            status: "ACTIVE",
            type: "APPLICATION",
            models: [
              {
                modelArn: "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-sonnet-4-6",
              },
            ],
          },
        ],
      });

    const models = await discoverBedrockModels({ region: "us-east-1", clientFactory });
    const profile = models.find((model) => model.id === "us.my-prod-profile");

    expect(profile).toMatchObject({
      id: "us.my-prod-profile",
      input: ["text", "image"],
      contextWindow: 1000000,
      maxTokens: 4096,
    });
  });

  it("uses the resolved base model id for application-profile context fallback", async () => {
    sendMock
      .mockResolvedValueOnce({
        modelSummaries: [],
      })
      .mockResolvedValueOnce({
        inferenceProfileSummaries: [
          {
            inferenceProfileId: "us.my-prod-profile",
            inferenceProfileName: "Prod Claude Profile",
            status: "ACTIVE",
            type: "APPLICATION",
            models: [
              {
                modelArn:
                  "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-opus-4-6-v1:0",
              },
            ],
          },
        ],
      });

    const models = await discoverBedrockModels({ region: "us-east-1", clientFactory });

    expect(models[0]).toMatchObject({
      id: "us.my-prod-profile",
      contextWindow: 1_000_000,
      maxTokens: 4096,
      input: ["text"],
    });
  });

  it("merges implicit Bedrock models into explicit provider overrides", () => {
    expect(
      mergeImplicitBedrockProvider({
        existing: {
          baseUrl: "https://override.example.com",
          headers: { "x-test-header": "1" },
          models: [],
        },
        implicit: {
          baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
          api: "bedrock-converse-stream",
          auth: "aws-sdk",
          models: [
            {
              id: "amazon.nova-micro-v1:0",
              name: "Nova",
              reasoning: false,
              input: ["text"],
              cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
              contextWindow: 1,
              maxTokens: 1,
            },
          ],
        },
      }).models?.map((model) => model.id),
    ).toEqual(["amazon.nova-micro-v1:0"]);
  });

  it("prefers plugin-owned discovery config and still honors legacy fallback", async () => {
    mockSingleActiveSummary();

    const pluginEnabled = await resolveImplicitBedrockProvider({
      config: {
        models: {
          bedrockDiscovery: {
            enabled: false,
            region: "us-west-2",
          },
        },
      },
      pluginConfig: {
        discovery: {
          enabled: true,
          region: "us-east-1",
        },
      },
      env: {} as NodeJS.ProcessEnv,
      clientFactory,
    });

    expect(pluginEnabled?.baseUrl).toBe("https://bedrock-runtime.us-east-1.amazonaws.com");
    // 2 calls per discovery (ListFoundationModels + ListInferenceProfiles).
    expect(sendMock).toHaveBeenCalledTimes(2);

    mockSingleActiveSummary();

    const legacyEnabled = await resolveImplicitBedrockProvider({
      config: {
        models: {
          bedrockDiscovery: {
            enabled: true,
            region: "us-west-2",
          },
        },
      },
      env: {} as NodeJS.ProcessEnv,
      clientFactory,
    });

    expect(legacyEnabled?.baseUrl).toBe("https://bedrock-runtime.us-west-2.amazonaws.com");
    expect(sendMock).toHaveBeenCalledTimes(4);
  });

  // Ported from #65449 by @alickgithub2 — extended to also cover apac. prefix
  it("resolves au. and apac. prefixes for regional inference profiles", async () => {
    sendMock
      .mockResolvedValueOnce({
        modelSummaries: [
          {
            modelId: "anthropic.claude-sonnet-4-6",
            modelName: "Claude Sonnet 4.6",
            providerName: "anthropic",
            inputModalities: ["TEXT", "IMAGE"],
            outputModalities: ["TEXT"],
            responseStreamingSupported: true,
            modelLifecycle: { status: "ACTIVE" },
          },
        ],
      })
      .mockResolvedValueOnce({
        inferenceProfileSummaries: [
          {
            inferenceProfileId: "au.anthropic.claude-sonnet-4-6",
            inferenceProfileName: "AU Anthropic Claude Sonnet 4.6",
            inferenceProfileArn:
              "arn:aws:bedrock:ap-southeast-2::inference-profile/au.anthropic.claude-sonnet-4-6",
            status: "ACTIVE",
            type: "SYSTEM_DEFINED",
            models: [], // no ARNs — forces the prefix-regex fallback
          },
          {
            inferenceProfileId: "apac.anthropic.claude-sonnet-4-6",
            inferenceProfileName: "APAC Anthropic Claude Sonnet 4.6",
            inferenceProfileArn:
              "arn:aws:bedrock:ap-northeast-1::inference-profile/apac.anthropic.claude-sonnet-4-6",
            status: "ACTIVE",
            type: "SYSTEM_DEFINED",
            models: [],
          },
        ],
      });

    const models = await discoverBedrockModels({ region: "ap-southeast-2", clientFactory });

    // Foundation model + 2 regional inference profiles
    expect(models).toHaveLength(3);

    const auProfile = models.find((m) => m.id === "au.anthropic.claude-sonnet-4-6");
    expect(auProfile).toMatchObject({
      id: "au.anthropic.claude-sonnet-4-6",
      name: "AU Anthropic Claude Sonnet 4.6",
      input: ["text", "image"],
    });

    const apacProfile = models.find((m) => m.id === "apac.anthropic.claude-sonnet-4-6");
    expect(apacProfile).toMatchObject({
      id: "apac.anthropic.claude-sonnet-4-6",
      name: "APAC Anthropic Claude Sonnet 4.6",
      input: ["text", "image"],
    });
  });
});
