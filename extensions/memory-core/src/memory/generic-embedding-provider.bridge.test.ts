// Memory Core tests cover generic embedding provider.bridge plugin behavior.
import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type { EmbeddingProvider } from "openclaw/plugin-sdk/embedding-providers";
import {
  createPluginRegistryFixture,
  registerVirtualTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import {
  clearEmbeddingProviders,
  createEmptyPluginRegistry,
  getActivePluginRegistry,
  getRegisteredEmbeddingProvider,
  listRegisteredEmbeddingProviders,
  type RegisteredEmbeddingProvider,
  restoreRegisteredEmbeddingProviders,
  setActivePluginRegistry,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEmbeddingProvider, resolveEmbeddingProviderIndexIdentity } from "./embeddings.js";

let embeddingProvidersSnapshot: RegisteredEmbeddingProvider[];
let previousPluginRegistry: ReturnType<typeof getActivePluginRegistry>;

function createOptions(config: OpenClawConfig) {
  return {
    config,
    agentDir: "/tmp/openclaw-agent",
    provider: "virtual-generic",
    fallback: "none",
    model: "virtual-model",
    outputDimensionality: 7,
  };
}

beforeEach(() => {
  previousPluginRegistry = getActivePluginRegistry();
  embeddingProvidersSnapshot = listRegisteredEmbeddingProviders();
  clearEmbeddingProviders();
});

afterEach(() => {
  clearEmbeddingProviders();
  setActivePluginRegistry(previousPluginRegistry ?? createEmptyPluginRegistry());
  restoreRegisteredEmbeddingProviders(embeddingProvidersSnapshot);
});

describe("memory-core generic embedding provider contract", () => {
  it("preserves a contract-declared provider and its identity metadata", async () => {
    let createdProvider: EmbeddingProvider | undefined;
    const { config, registry } = createPluginRegistryFixture({
      plugins: {
        enabled: false,
      },
    } as OpenClawConfig);

    registerVirtualTestPlugin({
      registry,
      config,
      id: "virtual-generic-plugin",
      name: "Virtual Generic Embeddings",
      contracts: {
        embeddingProviders: ["virtual-generic"],
      },
      register(api) {
        api.registerEmbeddingProvider({
          id: "virtual-generic",
          transport: "remote",
          defaultModel: "virtual-default",
          resolveIndexIdentity: (options) => ({
            model: options.model,
            cacheKeyData: {
              provider: "virtual-generic",
              model: options.model,
              dimensions: options.dimensions,
            },
            aliases: [
              {
                model: "virtual-model-legacy",
                cacheKeyData: {
                  provider: "virtual-generic",
                  model: "virtual-model-legacy",
                  dimensions: options.dimensions,
                },
              },
            ],
          }),
          create: async (options) => {
            expect(options.model).toBe("virtual-model");
            expect(options.dimensions).toBe(7);
            expect(options.config).toBe(config);
            createdProvider = {
              id: "virtual-generic",
              model: options.model,
              dimensions: options.dimensions,
              maxInputTokens: 2048,
              embed: async () => [1, 2, 3],
              embedBatch: async (inputs) => inputs.map((_input, index) => [index, 7]),
            };
            return {
              provider: createdProvider,
              runtime: {
                id: "virtual-generic",
                inlineQueryTimeoutMs: 1234,
                inlineBatchTimeoutMs: 5678,
                cacheKeyData: {
                  provider: "virtual-generic",
                  model: options.model,
                  dimensions: options.dimensions,
                },
                indexIdentityAliases: [
                  {
                    model: "virtual-model-legacy",
                    cacheKeyData: {
                      provider: "virtual-generic",
                      model: "virtual-model-legacy",
                      dimensions: options.dimensions,
                    },
                  },
                ],
              },
            };
          },
        });
      },
    });
    setActivePluginRegistry(registry.registry);

    expect(getRegisteredEmbeddingProvider("virtual-generic")?.ownerPluginId).toBe(
      "virtual-generic-plugin",
    );
    expect(registry.registry.embeddingProviders.map((entry) => entry.provider.id)).toEqual([
      "virtual-generic",
    ]);
    expect(resolveEmbeddingProviderIndexIdentity(createOptions(config))).toEqual({
      provider: { id: "virtual-generic", model: "virtual-model" },
      cacheKeyData: {
        provider: "virtual-generic",
        model: "virtual-model",
        dimensions: 7,
      },
      aliases: [
        {
          model: "virtual-model-legacy",
          cacheKeyData: {
            provider: "virtual-generic",
            model: "virtual-model-legacy",
            dimensions: 7,
          },
        },
      ],
    });

    const result = await createEmbeddingProvider(createOptions(config));

    expect(result.requestedProvider).toBe("virtual-generic");
    expect(result.provider).toMatchObject({
      id: "virtual-generic",
      model: "virtual-model",
      maxInputTokens: 2048,
    });
    expect(result.runtime).toEqual({
      id: "virtual-generic",
      inlineQueryTimeoutMs: 1234,
      inlineBatchTimeoutMs: 5678,
      cacheKeyData: {
        provider: "virtual-generic",
        model: "virtual-model",
        dimensions: 7,
      },
      indexIdentityAliases: [
        {
          model: "virtual-model-legacy",
          cacheKeyData: {
            provider: "virtual-generic",
            model: "virtual-model-legacy",
            dimensions: 7,
          },
        },
      ],
    });

    expect(result.provider).toBe(createdProvider);
  });
});
