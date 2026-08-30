// Amazon Bedrock tests cover memory embedding adapter plugin behavior.
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hasAwsCredentialsMock = vi.hoisted(() => vi.fn());
const createBedrockEmbeddingProviderMock = vi.hoisted(() => vi.fn());

vi.mock("./embedding-provider.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./embedding-provider.js")>();
  return {
    ...actual,
    hasAwsCredentials: hasAwsCredentialsMock,
    createBedrockEmbeddingProvider: createBedrockEmbeddingProviderMock,
  };
});

import { bedrockMemoryEmbeddingProviderAdapter } from "./memory-embedding-adapter.js";

function defaultCreateOptions() {
  return {
    config: {} as Record<string, unknown>,
    agentDir: "/tmp/test-agent",
    model: "",
  };
}

function stubCreate(client: {
  region: string;
  model: string;
  dimensions?: number;
  endpoint?: string;
}) {
  createBedrockEmbeddingProviderMock.mockResolvedValue({
    provider: {
      id: "bedrock",
      model: client.model,
      embed: async () => [],
      embedBatch: async () => [],
    },
    client,
  });
}

describe("bedrockMemoryEmbeddingProviderAdapter", () => {
  beforeEach(() => {
    hasAwsCredentialsMock.mockReset();
    createBedrockEmbeddingProviderMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  afterAll(() => {
    vi.doUnmock("./embedding-provider.js");
    vi.resetModules();
  });

  it("registers the expected adapter metadata", () => {
    expect(bedrockMemoryEmbeddingProviderAdapter.id).toBe("bedrock");
    expect(bedrockMemoryEmbeddingProviderAdapter.transport).toBe("remote");
    expect(bedrockMemoryEmbeddingProviderAdapter.authProviderId).toBe("amazon-bedrock");
    expect(bedrockMemoryEmbeddingProviderAdapter.autoSelectPriority).toBe(60);
    expect(bedrockMemoryEmbeddingProviderAdapter.allowExplicitWhenConfiguredAuto).toBe(true);
  });

  it("throws a missing-api-key sentinel error when AWS credentials are unavailable", async () => {
    hasAwsCredentialsMock.mockResolvedValue(false);

    await expect(
      bedrockMemoryEmbeddingProviderAdapter.create(defaultCreateOptions()),
    ).rejects.toThrow(/No API key found for provider "bedrock"/);
    await expect(
      bedrockMemoryEmbeddingProviderAdapter.create(defaultCreateOptions()),
    ).rejects.toThrow(/AWS credentials are not available/);

    expect(createBedrockEmbeddingProviderMock).not.toHaveBeenCalled();
  });

  it("creates the provider when AWS credentials are available", async () => {
    hasAwsCredentialsMock.mockResolvedValue(true);
    stubCreate({ region: "us-east-1", model: "amazon.titan-embed-text-v2:0", dimensions: 1024 });

    const result = await bedrockMemoryEmbeddingProviderAdapter.create(defaultCreateOptions());

    expect(result.provider?.id).toBe("bedrock");
    expect(result.runtime).toEqual({
      id: "bedrock",
      cacheKeyData: {
        provider: "bedrock",
        region: "us-east-1",
        model: "amazon.titan-embed-text-v2:0",
        dimensions: 1024,
      },
    });
    expect(createBedrockEmbeddingProviderMock).toHaveBeenCalledOnce();
  });

  it("invalidates cached embeddings when the configured PrivateLink endpoint changes", async () => {
    hasAwsCredentialsMock.mockResolvedValue(true);
    const firstEndpoint = "https://vpce-first.bedrock-runtime.us-east-1.vpce.amazonaws.com";
    const secondEndpoint = "https://vpce-second.bedrock-runtime.us-east-1.vpce.amazonaws.com";

    stubCreate({
      region: "us-east-1",
      model: "amazon.titan-embed-text-v2:0",
      dimensions: 1024,
      endpoint: firstEndpoint,
    });
    const first = await bedrockMemoryEmbeddingProviderAdapter.create(defaultCreateOptions());

    stubCreate({
      region: "us-east-1",
      model: "amazon.titan-embed-text-v2:0",
      dimensions: 1024,
      endpoint: secondEndpoint,
    });
    const second = await bedrockMemoryEmbeddingProviderAdapter.create(defaultCreateOptions());

    expect(first.runtime?.cacheKeyData).toMatchObject({ endpoint: firstEndpoint });
    expect(second.runtime?.cacheKeyData).toMatchObject({ endpoint: secondEndpoint });
    expect(first.runtime?.cacheKeyData).not.toEqual(second.runtime?.cacheKeyData);
  });

  it("preserves existing cache identity for canonical AWS regional provider URLs", async () => {
    hasAwsCredentialsMock.mockResolvedValue(true);
    const actual =
      await vi.importActual<typeof import("./embedding-provider.js")>("./embedding-provider.js");
    createBedrockEmbeddingProviderMock.mockImplementation(actual.createBedrockEmbeddingProvider);
    vi.stubEnv("AWS_REGION", "us-east-1");
    vi.stubEnv("AWS_DEFAULT_REGION", undefined);
    vi.stubEnv("AWS_ENDPOINT_URL", undefined);
    vi.stubEnv("AWS_ENDPOINT_URL_BEDROCK_RUNTIME", undefined);

    const result = await bedrockMemoryEmbeddingProviderAdapter.create({
      ...defaultCreateOptions(),
      config: {
        models: {
          providers: {
            "amazon-bedrock": {
              baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
              models: [],
            },
          },
        },
      },
    });

    expect(result.runtime?.cacheKeyData).toEqual({
      provider: "bedrock",
      region: "us-east-1",
      model: "amazon.titan-embed-text-v2:0",
      dimensions: 1024,
    });
  });

  it("lets the auto-select loop skip bedrock when credentials are unavailable", async () => {
    hasAwsCredentialsMock.mockResolvedValue(false);

    let thrown: unknown;
    try {
      await bedrockMemoryEmbeddingProviderAdapter.create(defaultCreateOptions());
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(Error);
    expect(bedrockMemoryEmbeddingProviderAdapter.shouldContinueAutoSelection?.(thrown)).toBe(true);
  });
});
