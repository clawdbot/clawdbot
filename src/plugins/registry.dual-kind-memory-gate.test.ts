/** Verifies memory provider registration keeps text and binary embedding kinds isolated. */
import {
  createPluginRegistryFixture,
  registerTestPlugin,
  registerVirtualTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import { describe, expect, it } from "vitest";
import { LEGACY_MEMORY_AUTHORIZATION_CAPABILITIES } from "../plugin-sdk/memory-authorization.js";
import {
  resolveMemoryCapabilityRegistration,
  resolveSelectedMemoryCapabilityRegistration,
} from "./memory-state.js";
import { createPluginRecord } from "./status.test-fixtures.js";

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

function requireMemoryRuntime(
  registry: ReturnType<typeof createPluginRegistryFixture>["registry"],
) {
  const runtime = registry.registry.memoryCapabilities.at(-1)?.capability.runtime;
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
        api.registerMemoryCapability({ runtime: createStubMemoryRuntime() });
      },
    });
    expect(registry.registry.memoryCapabilities).toStrictEqual([]);
    expect(registry.registry.diagnostics).toEqual([
      {
        pluginId: "dual-plugin",
        level: "warn",
        source: "/virtual/dual-plugin/index.ts",
        message:
          "dual-kind plugin not selected for memory slot; skipping memory capability registration",
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
        api.registerMemoryCapability({ runtime: createStubMemoryRuntime() });
      },
    });
    expect(
      requireMemoryRuntime(registry).resolveMemoryBackendConfig({
        cfg: {} as never,
        agentId: "main",
      }),
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
        api.registerMemoryCapability({ runtime: createStubMemoryRuntime() });
      },
    });
    expect(
      requireMemoryRuntime(registry).resolveMemoryBackendConfig({
        cfg: {} as never,
        agentId: "main",
      }),
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
    expect(registry.registry.memoryCapabilities).toEqual([
      {
        pluginId: "dual-plugin",
        capability: {
          runtime,
          promptBuilder,
        },
      },
    ]);
    expect(
      requireMemoryRuntime(registry).resolveMemoryBackendConfig({
        cfg: {} as never,
        agentId: "main",
      }),
    ).toEqual({ backend: "builtin" });
  });

  it("preserves an earlier memory capability when an artifact bridge fails", () => {
    const { config, registry } = createPluginRegistryFixture();
    const runtime = createStubMemoryRuntime();
    const flushPlanResolver = () => null;
    const coreRecord = createPluginRecord({
      id: "memory-core",
      name: "Memory Core",
      kind: "memory",
    });
    registerTestPlugin({
      registry,
      config,
      record: coreRecord,
      register(api) {
        api.registerMemoryCapability({ runtime, flushPlanResolver });
      },
    });

    const bridgeRecord = createPluginRecord({
      id: "memory-bridge",
      name: "Memory Bridge",
      kind: "memory",
    });
    expect(() =>
      registerTestPlugin({
        registry,
        config,
        record: bridgeRecord,
        register(api) {
          api.registerMemoryCapability({
            publicArtifacts: { listArtifacts: async () => [] },
          });
          throw new Error("bridge failed");
        },
      }),
    ).toThrow("bridge failed");
    registry.rollbackPluginGlobalSideEffects(bridgeRecord.id, bridgeRecord);

    expect(registry.registry.memoryCapabilities).toEqual([
      { pluginId: "memory-core", capability: { runtime, flushPlanResolver } },
    ]);
    expect(resolveMemoryCapabilityRegistration(registry.registry.memoryCapabilities)).toEqual({
      pluginId: "memory-core",
      capability: { runtime, flushPlanResolver },
    });
  });

  it("layers same-plugin public artifacts over its runtime capability", () => {
    const { config, registry } = createPluginRegistryFixture();
    const runtime = createStubMemoryRuntime();
    const flushPlanResolver = () => null;
    const record = createPluginRecord({ id: "memory-core", name: "Memory Core", kind: "memory" });

    registerTestPlugin({
      registry,
      config,
      record,
      register(api) {
        api.registerMemoryCapability({
          authorization: LEGACY_MEMORY_AUTHORIZATION_CAPABILITIES,
          runtime,
          flushPlanResolver,
        });
        api.registerMemoryCapability({ publicArtifacts: { listArtifacts: async () => [] } });
      },
    });

    expect(
      resolveMemoryCapabilityRegistration(registry.registry.memoryCapabilities, "memory-core"),
    ).toEqual({
      pluginId: "memory-core",
      capability: {
        authorization: LEGACY_MEMORY_AUTHORIZATION_CAPABILITIES,
        runtime,
        flushPlanResolver,
        publicArtifacts: expect.any(Object),
      },
    });
  });

  it("does not borrow sidecar authorization when the selected backend omits it", () => {
    const { config, registry } = createPluginRegistryFixture();
    const runtime = createStubMemoryRuntime();
    const publicArtifacts = { listArtifacts: async () => [] };

    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({ id: "memory-core", name: "Memory Core", kind: "memory" }),
      register(api) {
        api.registerMemoryCapability({
          authorization: LEGACY_MEMORY_AUTHORIZATION_CAPABILITIES,
          runtime,
        });
      },
    });
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "memory-lancedb",
        name: "Memory LanceDB",
        kind: "memory",
        memorySlotSelected: true,
      }),
      register(api) {
        api.registerMemoryCapability({ publicArtifacts });
      },
    });

    const resolved = resolveSelectedMemoryCapabilityRegistration(registry.registry);
    expect(resolved).toEqual({
      pluginId: "memory-lancedb",
      capability: { runtime, publicArtifacts },
    });
    expect(resolved?.capability).not.toHaveProperty("authorization");
  });
});
