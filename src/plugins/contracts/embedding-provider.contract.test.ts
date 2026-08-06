// Embedding provider contract tests cover plugin embedding provider SDK behavior.
import * as embeddingProviderSdk from "openclaw/plugin-sdk/embedding-providers";
import {
  createPluginRegistryFixture,
  registerVirtualTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import { describe, expect, it } from "vitest";

describe("embedding provider registration", () => {
  it("keeps public SDK helpers read-only so plugins cannot bypass manifest ownership", () => {
    expect(embeddingProviderSdk).not.toHaveProperty("registerEmbeddingProvider");
    expect(embeddingProviderSdk).not.toHaveProperty("listRegisteredEmbeddingProviders");
    expect(embeddingProviderSdk).not.toHaveProperty("clearEmbeddingProviders");
    expect(embeddingProviderSdk).not.toHaveProperty("restoreEmbeddingProviders");
    expect(embeddingProviderSdk).not.toHaveProperty("restoreRegisteredEmbeddingProviders");
  });

  it("rejects plugins that did not declare the capability contract", () => {
    const { config, registry } = createPluginRegistryFixture();

    registerVirtualTestPlugin({
      registry,
      config,
      id: "not-embedding",
      name: "Not Embedding",
      register(api) {
        api.registerEmbeddingProvider({
          id: "forbidden",
          create: async () => ({ provider: null }),
        });
      },
    });
    expect(registry.registry.embeddingProviders).toStrictEqual([]);
    const diagnostic = registry.registry.diagnostics.find(
      (entry) => entry.pluginId === "not-embedding",
    );
    expect(diagnostic?.message).toBe(
      "plugin must declare contracts.embeddingProviders for adapter: forbidden",
    );
  });

  it("allows plugins that declare the capability contract", () => {
    const { config, registry } = createPluginRegistryFixture();

    registerVirtualTestPlugin({
      registry,
      config,
      id: "embedding-owner",
      name: "Embedding Owner",
      contracts: {
        embeddingProviders: ["embedding-owner"],
      },
      register(api) {
        api.registerEmbeddingProvider({
          id: "embedding-owner",
          create: async () => ({ provider: null }),
        });
      },
    });
    const provider = registry.registry.embeddingProviders[0];
    expect(provider?.provider.id).toBe("embedding-owner");
    expect(provider?.pluginId).toBe("embedding-owner");
    expect(registry.registry.embeddingProviders).toHaveLength(1);
    expect(registry.registry.plugins[0]?.embeddingProviderIds).toContain("embedding-owner");
  });

  it("rejects duplicate provider ids", () => {
    const { config, registry } = createPluginRegistryFixture();

    for (const id of ["first-owner", "second-owner"]) {
      registerVirtualTestPlugin({
        registry,
        config,
        id,
        name: id,
        contracts: {
          embeddingProviders: ["shared"],
        },
        register(api) {
          api.registerEmbeddingProvider({
            id: "shared",
            create: async () => ({ provider: null }),
          });
        },
      });
    }

    expect(registry.registry.embeddingProviders).toHaveLength(1);
    const diagnostic = registry.registry.diagnostics.find(
      (entry) => entry.pluginId === "second-owner",
    );
    expect(diagnostic?.message).toBe(
      "embedding provider already registered: shared (owner: first-owner)",
    );
  });

  it("keeps core embedding provider ids reserved", () => {
    const { config, registry } = createPluginRegistryFixture();

    registerVirtualTestPlugin({
      registry,
      config,
      id: "core-shadow",
      name: "Core Shadow",
      contracts: {
        embeddingProviders: ["openai-compatible"],
      },
      register(api) {
        api.registerEmbeddingProvider({
          id: "openai-compatible",
          create: async () => ({ provider: null }),
        });
      },
    });

    expect(registry.registry.embeddingProviders).toStrictEqual([]);
    const diagnostic = registry.registry.diagnostics.find(
      (entry) => entry.pluginId === "core-shadow",
    );
    expect(diagnostic?.message).toBe(
      "embedding provider already registered: openai-compatible (owner: core)",
    );
  });
});
