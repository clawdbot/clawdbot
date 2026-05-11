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

function requireMemoryRuntime() {
  const runtime = getMemoryRuntime();
  if (!runtime) {
    throw new Error("expected memory runtime registration");
  }
  return runtime;
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
    expect(registry.registry.diagnostics).toEqual([
      {
        pluginId: "dual-plugin",
        level: "warn",
        source: "/virtual/dual-plugin/index.ts",
        message:
          "dual-kind plugin not selected for memory slot; skipping memory runtime registration",
      },
    ]);
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

    expect(
      requireMemoryRuntime().resolveMemoryBackendConfig({ cfg: {} as never, agentId: "main" }),
    ).toEqual({ backend: "builtin" });
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

    expect(
      requireMemoryRuntime().resolveMemoryBackendConfig({ cfg: {} as never, agentId: "main" }),
    ).toEqual({ backend: "builtin" });
  });

  it("allows selected dual-kind plugins to register the unified memory capability", () => {
    const { config, registry } = createPluginRegistryFixture();
    const runtime = createStubMemoryRuntime();
    const promptBuilder = () => ["memory capability"];

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
          runtime,
          promptBuilder,
        });
      },
    });

    expect(getMemoryCapabilityRegistration()).toEqual({
      pluginId: "dual-plugin",
      capability: {
        runtime,
        promptBuilder,
      },
    });
    expect(
      requireMemoryRuntime().resolveMemoryBackendConfig({ cfg: {} as never, agentId: "main" }),
    ).toEqual({ backend: "builtin" });
  });
});
