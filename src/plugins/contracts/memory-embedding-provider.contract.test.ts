import {
  createPluginRegistryFixture,
  registerVirtualTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import { describe, expect, it } from "vitest";
import { getRegisteredMemoryEmbeddingProvider } from "../memory-embedding-providers.js";
import { createPluginRecord } from "../status.test-helpers.js";

describe("memory embedding provider registration", () => {
  it("rejects non-memory plugins that did not declare the capability contract", () => {
    const { config, registry } = createPluginRegistryFixture();

    registerVirtualTestPlugin({
      registry,
      config,
      id: "not-memory",
      name: "Not Memory",
      register(api) {
        api.registerMemoryEmbeddingProvider({
          id: "forbidden",
          create: async () => ({ provider: null }),
        });
      },
    });

    expect(getRegisteredMemoryEmbeddingProvider("forbidden")).toBeUndefined();
    expect(registry.registry.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pluginId: "not-memory",
          message:
            "plugin must own memory slot or declare contracts.memoryEmbeddingProviders for adapter: forbidden",
        }),
      ]),
    );
  });

  it("allows non-memory plugins that declare the capability contract", () => {
    const { config, registry } = createPluginRegistryFixture();

    registerVirtualTestPlugin({
      registry,
      config,
      id: "external-vector",
      name: "External Vector",
      contracts: {
        memoryEmbeddingProviders: ["external-vector"],
      },
      register(api) {
        api.registerMemoryEmbeddingProvider({
          id: "external-vector",
          create: async () => ({ provider: null }),
        });
      },
    });

    expect(getRegisteredMemoryEmbeddingProvider("external-vector")).toEqual({
      adapter: expect.objectContaining({ id: "external-vector" }),
      ownerPluginId: "external-vector",
    });
  });

  it("records the owning memory plugin id for registered adapters", () => {
    const { config, registry } = createPluginRegistryFixture();

    registerVirtualTestPlugin({
      registry,
      config,
      id: "memory-core",
      name: "Memory Core",
      kind: "memory",
      register(api) {
        api.registerMemoryEmbeddingProvider({
          id: "demo-embedding",
          create: async () => ({ provider: null }),
        });
      },
    });

    expect(getRegisteredMemoryEmbeddingProvider("demo-embedding")).toEqual({
      adapter: expect.objectContaining({ id: "demo-embedding" }),
      ownerPluginId: "memory-core",
    });
  });

  it("keeps companion embedding providers available during tool discovery", () => {
    const { config, registry } = createPluginRegistryFixture();
    const record = createPluginRecord({
      id: "tool-discovery-memory",
      name: "Tool Discovery Memory",
      kind: "memory",
      contracts: { tools: ["memory_recall"] },
    });
    registry.registry.plugins.push(record);
    const api = registry.createApi(record, {
      config,
      registrationMode: "tool-discovery",
    });

    api.registerMemoryEmbeddingProvider({
      id: "tool-discovery-embedding",
      create: async () => ({ provider: null }),
    });
    api.registerTool({
      name: "memory_recall",
      label: "Memory Recall",
      description: "Recall memory",
      parameters: {},
      execute: async () => ({ content: [], details: {} }),
    });

    expect(getRegisteredMemoryEmbeddingProvider("tool-discovery-embedding")).toEqual({
      adapter: expect.objectContaining({ id: "tool-discovery-embedding" }),
      ownerPluginId: "tool-discovery-memory",
    });
    expect(registry.registry.tools).toEqual([
      expect.objectContaining({
        pluginId: "tool-discovery-memory",
        names: ["memory_recall"],
      }),
    ]);
  });
});
