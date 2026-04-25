import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

function stubCreate(client: { region: string; model: string; dimensions?: number }) {
  createBedrockEmbeddingProviderMock.mockResolvedValue({
    provider: {
      id: "bedrock",
      model: client.model,
      embedQuery: async () => [],
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
