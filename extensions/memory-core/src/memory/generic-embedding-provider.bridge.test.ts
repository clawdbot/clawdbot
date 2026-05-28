import type { OpenClawConfig } from "openclaw/plugin-sdk/config-contracts";
import type {
  EmbeddingInput,
  EmbeddingProviderCallOptions,
} from "openclaw/plugin-sdk/embedding-providers";
import {
  createPluginRegistryFixture,
  registerVirtualTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import {
  clearEmbeddingProviders,
  getRegisteredEmbeddingProvider,
  listRegisteredEmbeddingProviders,
  type RegisteredEmbeddingProvider,
  restoreRegisteredEmbeddingProviders,
  clearMemoryEmbeddingProviders,
  listRegisteredMemoryEmbeddingProviders,
  type RegisteredMemoryEmbeddingProvider,
  restoreRegisteredMemoryEmbeddingProviders,
} from "openclaw/plugin-sdk/plugin-test-runtime";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createEmbeddingProvider } from "./embeddings.js";

type CapturedCall = {
  kind: "embed" | "embedBatch";
  input: EmbeddingInput | EmbeddingInput[];
  options: EmbeddingProviderCallOptions | undefined;
};

let embeddingProvidersSnapshot: RegisteredEmbeddingProvider[];
let memoryEmbeddingProvidersSnapshot: RegisteredMemoryEmbeddingProvider[];

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
  embeddingProvidersSnapshot = listRegisteredEmbeddingProviders();
  memoryEmbeddingProvidersSnapshot = listRegisteredMemoryEmbeddingProviders();
  clearEmbeddingProviders();
  clearMemoryEmbeddingProviders();
});

afterEach(() => {
  restoreRegisteredEmbeddingProviders(embeddingProvidersSnapshot);
  restoreRegisteredMemoryEmbeddingProviders(memoryEmbeddingProvidersSnapshot);
});

describe("memory-core generic embedding provider bridge", () => {
  it("adapts a contract-declared generic embedding plugin into explicit memory requests", async () => {
    const calls: CapturedCall[] = [];
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
          create: async (options) => {
            expect(options.model).toBe("virtual-model");
            expect(options.dimensions).toBe(7);
            expect(options.config).toBe(config);
            return {
              provider: {
                id: "virtual-generic",
                model: options.model,
                dimensions: options.dimensions,
                maxInputTokens: 2048,
                embed: async (input, callOptions) => {
                  calls.push({ kind: "embed", input, options: callOptions });
                  return callOptions?.inputType === "query" ? [1, 2, 3] : [0];
                },
                embedBatch: async (inputs, callOptions) => {
                  calls.push({ kind: "embedBatch", input: inputs, options: callOptions });
                  return inputs.map((_input, index) =>
                    callOptions?.inputType === "document" ? [index, 7] : [0],
                  );
                },
              },
              runtime: {
                id: "virtual-generic",
                inlineQueryTimeoutMs: 1234,
                inlineBatchTimeoutMs: 5678,
                cacheKeyData: {
                  provider: "virtual-generic",
                  model: options.model,
                  dimensions: options.dimensions,
                },
              },
            };
          },
        });
      },
    });

    expect(getRegisteredEmbeddingProvider("virtual-generic")?.ownerPluginId).toBe(
      "virtual-generic-plugin",
    );
    expect(registry.registry.embeddingProviders.map((entry) => entry.provider.id)).toEqual([
      "virtual-generic",
    ]);
    expect(listRegisteredMemoryEmbeddingProviders()).toEqual([]);

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
    });

    await expect(result.provider?.embedQuery("query")).resolves.toEqual([1, 2, 3]);
    await expect(result.provider?.embedBatch(["doc-a", "doc-b"])).resolves.toEqual([
      [0, 7],
      [1, 7],
    ]);
    await expect(
      result.provider?.embedBatchInputs?.([
        {
          text: "structured doc",
          parts: [{ type: "text", text: "structured doc" }],
        },
      ]),
    ).resolves.toEqual([[0, 7]]);

    expect(calls).toEqual([
      {
        kind: "embed",
        input: "query",
        options: { inputType: "query" },
      },
      {
        kind: "embedBatch",
        input: ["doc-a", "doc-b"],
        options: { inputType: "document" },
      },
      {
        kind: "embedBatch",
        input: [
          {
            text: "structured doc",
            parts: [{ type: "text", text: "structured doc" }],
          },
        ],
        options: { inputType: "document" },
      },
    ]);
  });
});
