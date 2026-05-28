import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { EmbeddingProviderAdapter } from "openclaw/plugin-sdk/embedding-providers";
import type { MemoryEmbeddingProviderAdapter } from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmbeddingProvider, resolveEmbeddingProviderFallbackModel } from "./embeddings.js";

const mockEmbeddingRegistry = vi.hoisted(() => ({
  genericAdapters: [] as EmbeddingProviderAdapter[],
  adapters: [] as MemoryEmbeddingProviderAdapter[],
  genericLookupConfigs: [] as Array<OpenClawConfig | undefined>,
}));

vi.mock("openclaw/plugin-sdk/embedding-providers", () => ({
  getEmbeddingProvider: (id: string, config?: OpenClawConfig) => {
    mockEmbeddingRegistry.genericLookupConfigs.push(config);
    return mockEmbeddingRegistry.genericAdapters.find((adapter) => adapter.id === id);
  },
  listEmbeddingProviders: () => [...mockEmbeddingRegistry.genericAdapters],
}));

vi.mock("openclaw/plugin-sdk/memory-core-host-engine-embeddings", () => ({
  DEFAULT_LOCAL_MODEL: "nomic-embed-text",
  createLocalEmbeddingProvider: async () => {
    throw new Error("local embedding provider is not used by these tests");
  },
  getMemoryEmbeddingProvider: (id: string) =>
    mockEmbeddingRegistry.adapters.find((adapter) => adapter.id === id),
  listMemoryEmbeddingProviders: () => [...mockEmbeddingRegistry.adapters],
  listRegisteredMemoryEmbeddingProviderAdapters: () => [...mockEmbeddingRegistry.adapters],
  listRegisteredMemoryEmbeddingProviders: () =>
    mockEmbeddingRegistry.adapters.map((adapter) => ({ adapter })),
}));

const missingBedrockCredentialsError = new Error(
  'No API key found for provider "bedrock". AWS credentials are not available.',
);

function createOptions(provider: string) {
  return {
    config: {
      plugins: {
        deny: [
          "amazon-bedrock",
          "github-copilot",
          "google",
          "lmstudio",
          "memory-core",
          "mistral",
          "ollama",
          "openai",
          "voyage",
        ],
      },
    } as OpenClawConfig,
    agentDir: "/tmp/openclaw-agent",
    provider,
    fallback: "none",
    model: "",
  };
}

function createMissingCredentialsAdapter(
  overrides: Partial<MemoryEmbeddingProviderAdapter> = {},
): MemoryEmbeddingProviderAdapter {
  return {
    id: "bedrock",
    transport: "remote",
    autoSelectPriority: 60,
    formatSetupError: (err) => (err instanceof Error ? err.message : String(err)),
    shouldContinueAutoSelection: (err) =>
      err instanceof Error && err.message.includes("No API key found for provider"),
    create: async () => {
      throw missingBedrockCredentialsError;
    },
    ...overrides,
  };
}

function clearMemoryEmbeddingProviders(): void {
  mockEmbeddingRegistry.genericAdapters = [];
  mockEmbeddingRegistry.adapters = [];
  mockEmbeddingRegistry.genericLookupConfigs = [];
}

function registerGenericEmbeddingProvider(adapter: EmbeddingProviderAdapter): void {
  mockEmbeddingRegistry.genericAdapters = mockEmbeddingRegistry.genericAdapters.filter(
    (candidate) => candidate.id !== adapter.id,
  );
  mockEmbeddingRegistry.genericAdapters.push(adapter);
}

function registerMemoryEmbeddingProvider(adapter: MemoryEmbeddingProviderAdapter): void {
  mockEmbeddingRegistry.adapters = mockEmbeddingRegistry.adapters.filter(
    (candidate) => candidate.id !== adapter.id,
  );
  mockEmbeddingRegistry.adapters.push(adapter);
}

describe("createEmbeddingProvider", () => {
  beforeEach(() => {
    clearMemoryEmbeddingProviders();
  });

  afterEach(() => {
    clearMemoryEmbeddingProviders();
  });

  it("normalizes legacy auto mode to OpenAI", async () => {
    registerMemoryEmbeddingProvider(createMissingCredentialsAdapter({ id: "bedrock" }));
    registerMemoryEmbeddingProvider({
      id: "openai",
      transport: "remote",
      autoSelectPriority: 20,
      create: async () => ({
        provider: {
          id: "openai",
          model: "text-embedding-3-small",
          embedQuery: async () => [1],
          embedBatch: async (texts) => texts.map(() => [1]),
        },
      }),
    });

    const result = await createEmbeddingProvider(createOptions("auto"));

    expect(result.provider?.id).toBe("openai");
    expect(result.requestedProvider).toBe("openai");
  });

  it("still throws missing credentials for an explicit provider request", async () => {
    registerMemoryEmbeddingProvider(createMissingCredentialsAdapter());

    await expect(createEmbeddingProvider(createOptions("bedrock"))).rejects.toThrow(
      missingBedrockCredentialsError.message,
    );
  });

  it("does not run priority-based auto-selection after a skippable setup failure", async () => {
    registerMemoryEmbeddingProvider(createMissingCredentialsAdapter({ autoSelectPriority: 10 }));
    registerMemoryEmbeddingProvider({
      id: "openai",
      transport: "remote",
      autoSelectPriority: 20,
      create: async () => ({
        provider: {
          id: "openai",
          model: "text-embedding-3-small",
          embedQuery: async () => [1],
          embedBatch: async (texts) => texts.map(() => [1]),
        },
      }),
    });

    const result = await createEmbeddingProvider(createOptions("auto"));

    expect(result.provider?.id).toBe("openai");
    expect(result.requestedProvider).toBe("openai");
  });

  it("uses a generic embedding provider when no memory-specific provider exists", async () => {
    registerGenericEmbeddingProvider({
      id: "openai-compatible",
      create: async () => ({
        provider: {
          id: "generic",
          model: "generic-model",
          embed: async (_input, options) => (options?.inputType === "query" ? [1] : [2]),
          embedBatch: async (inputs, options) =>
            inputs.map(() => (options?.inputType === "document" ? [3] : [4])),
        },
      }),
    });

    const options = createOptions("openai-compatible");
    const result = await createEmbeddingProvider(options);

    expect(result.provider?.id).toBe("generic");
    expect(mockEmbeddingRegistry.genericLookupConfigs).toEqual([options.config]);
    await expect(result.provider?.embedQuery("hello")).resolves.toEqual([1]);
    await expect(result.provider?.embedBatch(["doc"])).resolves.toEqual([[3]]);
  });

  it("keeps memory-specific providers authoritative during dual registration", async () => {
    registerGenericEmbeddingProvider({
      id: "openai-compatible",
      create: async () => ({
        provider: {
          id: "generic",
          model: "generic-model",
          embed: async (_input, options) => (options?.inputType === "query" ? [1] : [2]),
          embedBatch: async (inputs, options) =>
            inputs.map(() => (options?.inputType === "document" ? [3] : [4])),
        },
      }),
    });
    registerMemoryEmbeddingProvider({
      id: "openai-compatible",
      create: async () => ({
        provider: {
          id: "legacy",
          model: "legacy-model",
          embedQuery: async () => [0],
          embedBatch: async (texts) => texts.map(() => [0]),
        },
      }),
    });

    const result = await createEmbeddingProvider(createOptions("openai-compatible"));

    expect(result.provider?.id).toBe("legacy");
    await expect(result.provider?.embedQuery("hello")).resolves.toEqual([0]);
  });

  it("does not auto-select generic providers by priority policy", async () => {
    registerMemoryEmbeddingProvider({
      id: "openai-compatible",
      transport: "remote",
      autoSelectPriority: 20,
      create: async () => ({
        provider: {
          id: "legacy",
          model: "legacy-model",
          embedQuery: async () => [1],
          embedBatch: async (texts) => texts.map(() => [1]),
        },
      }),
    });
    registerGenericEmbeddingProvider({
      id: "openai-compatible",
      create: async () => ({
        provider: {
          id: "generic",
          model: "generic-model",
          embed: async () => [2],
          embedBatch: async (inputs) => inputs.map(() => [2]),
        },
      }),
    });

    await expect(createEmbeddingProvider(createOptions("auto"))).rejects.toThrow(
      "Unknown memory embedding provider: openai",
    );
  });

  it("uses config-scoped lookup for generic fallback model resolution", () => {
    registerGenericEmbeddingProvider({
      id: "openai-compatible",
      defaultModel: "generic-default",
      create: async () => ({
        provider: null,
      }),
    });
    const options = createOptions("openai-compatible");

    const model = resolveEmbeddingProviderFallbackModel(
      "openai-compatible",
      "source-model",
      options.config,
    );

    expect(model).toBe("generic-default");
    expect(mockEmbeddingRegistry.genericLookupConfigs).toEqual([options.config]);
  });
});
