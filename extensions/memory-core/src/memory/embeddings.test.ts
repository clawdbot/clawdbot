import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { MemoryEmbeddingProviderAdapter } from "openclaw/plugin-sdk/memory-core-host-engine-embeddings";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createEmbeddingProvider } from "./embeddings.js";

const mockEmbeddingRegistry = vi.hoisted(() => ({
  adapters: [] as MemoryEmbeddingProviderAdapter[],
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
  mockEmbeddingRegistry.adapters = [];
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

  it("returns no provider in auto mode when all candidates are skippable setup failures", async () => {
    registerMemoryEmbeddingProvider(createMissingCredentialsAdapter());

    const result = await createEmbeddingProvider(createOptions("auto"));

    expect(result).toEqual({
      provider: null,
      requestedProvider: "auto",
      providerUnavailableReason: missingBedrockCredentialsError.message,
    });
  });

  it("still throws missing credentials for an explicit provider request", async () => {
    registerMemoryEmbeddingProvider(createMissingCredentialsAdapter());

    await expect(createEmbeddingProvider(createOptions("bedrock"))).rejects.toThrow(
      missingBedrockCredentialsError.message,
    );
  });

  it("continues auto-selection after a skippable setup failure", async () => {
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
    expect(result.requestedProvider).toBe("auto");
  });
});
