import {
  createPluginRegistryFixture,
  registerTestPlugin,
  registerVirtualTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import { afterEach, describe, expect, it } from "vitest";
import { clearMemoryEmbeddingProviders } from "./memory-embedding-providers.js";
import {
  _resetMemoryPluginState,
  getMemoryCapabilityRegistration,
  getMemoryRuntime,
} from "./memory-state.js";
import { createPluginRecord } from "./status.test-helpers.js";

afterEach(() => {
  _resetMemoryPluginState();
  clearMemoryEmbeddingProviders();
});

function createStubMemoryRuntime() {
  return {
    async getMemorySearchManager() {
      return { manager: null, error: "missing" } as const;
    },
    resolveMemoryBackendConfig() {
      return { backend: "builtin" as const };
    },
  };
}

describe("dual-kind memory registration gate", () => {
  it("blocks memory runtime registration for dual-kind plugins not selected for memory slot", () => {
    const { config, registry } = createPluginRegistryFixture();

    registerVirtualTestPlugin({
      registry,
      config,
      id: "dual-plugin",
      name: "Dual Plugin",
      kind: ["memory", "context-engine"],
      register(api) {
        api.registerMemoryRuntime(createStubMemoryRuntime());
      },
    });

    expect(getMemoryRuntime()).toBeUndefined();
    expect(registry.registry.diagnostics).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pluginId: "dual-plugin",
          level: "warn",
          message: expect.stringContaining("dual-kind plugin not selected for memory slot"),
        }),
      ]),
    );
  });

  it("allows memory runtime registration for dual-kind plugins selected for memory slot", () => {
    const { config, registry } = createPluginRegistryFixture();

    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "dual-plugin",
        name: "Dual Plugin",
        kind: ["memory", "context-engine"],
        memorySlotSelected: true,
      }),
      register(api) {
        api.registerMemoryRuntime(createStubMemoryRuntime());
      },
    });

    expect(getMemoryRuntime()).toBeDefined();
    expect(
      registry.registry.diagnostics.filter(
        (d) => d.pluginId === "dual-plugin" && d.level === "warn",
      ),
    ).toHaveLength(0);
  });

  it("allows memory runtime registration for single-kind memory plugins without memorySlotSelected", () => {
    const { config, registry } = createPluginRegistryFixture();

    registerVirtualTestPlugin({
      registry,
      config,
      id: "memory-only",
      name: "Memory Only",
      kind: "memory",
      register(api) {
        api.registerMemoryRuntime(createStubMemoryRuntime());
      },
    });

    expect(getMemoryRuntime()).toBeDefined();
  });

  it("allows selected dual-kind plugins to register the unified memory capability", () => {
    const { config, registry } = createPluginRegistryFixture();

    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "dual-plugin",
        name: "Dual Plugin",
        kind: ["memory", "context-engine"],
        memorySlotSelected: true,
      }),
      register(api) {
        api.registerMemoryCapability({
          runtime: createStubMemoryRuntime(),
          promptBuilder: () => ["memory capability"],
        });
      },
    });

    expect(getMemoryCapabilityRegistration()).toMatchObject({
      pluginId: "dual-plugin",
    });
    expect(getMemoryRuntime()).toBeDefined();
  });
});
