/** Verifies memory capability registration keeps slot ownership explicit. */
import {
  createPluginRegistryFixture,
  registerTestPlugin,
  registerVirtualTestPlugin,
} from "openclaw/plugin-sdk/plugin-test-contracts";
import { afterEach, describe, expect, it } from "vitest";
import { resolveMemoryCapabilityRegistration } from "./memory-state.js";
import { clearActivePluginRegistry, setActivePluginRegistry } from "./runtime.js";
import { createPluginRecord } from "./status.test-fixtures.js";

afterEach(async () => {
  await clearActivePluginRegistry();
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
    setActivePluginRegistry(registry.registry);
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
    setActivePluginRegistry(registry.registry);
    expect(
      requireMemoryRuntime(registry).resolveMemoryBackendConfig({
        cfg: config,
        agentId: "main",
      }),
    ).toEqual({ backend: "builtin" });
    expect(
      registry.registry.diagnostics.filter(
        (d) => d.pluginId === "dual-plugin" && d.level === "warn",
      ),
    ).toHaveLength(0);
  });

  it("drops the indexing runtime of single-kind memory plugins not selected for the memory slot", () => {
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
    setActivePluginRegistry(registry.registry);
    expect(registry.registry.memoryCapabilities).toEqual([
      { pluginId: "memory-only", capability: {}, memorySlotSelected: false },
    ]);
    expect(
      registry.registry.diagnostics.filter(
        (d) => d.pluginId === "memory-only" && d.level === "warn",
      ),
    ).toHaveLength(1);
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
    setActivePluginRegistry(registry.registry);
    expect(registry.registry.memoryCapabilities).toHaveLength(1);
    const registered = registry.registry.memoryCapabilities[0]!;
    expect(registered.pluginId).toBe("dual-plugin");
    expect(registered.memorySlotSelected).toBe(true);
    expect(registered.capability.promptBuilder?.({ availableTools: new Set() })).toEqual([
      "memory capability",
    ]);
    expect(
      requireMemoryRuntime(registry).resolveMemoryBackendConfig({
        cfg: config,
        agentId: "main",
      }),
    ).toEqual({ backend: "builtin" });
  });

  it("preserves an earlier memory capability when an artifact bridge fails", async () => {
    const { config, registry } = createPluginRegistryFixture();
    const runtime = createStubMemoryRuntime();
    const flushPlanResolver = () => null;
    const coreRecord = createPluginRecord({
      id: "memory-core",
      name: "Memory Core",
      kind: "memory",
      memorySlotSelected: true,
    });
    registerTestPlugin({
      registry,
      config,
      record: coreRecord,
      register(api) {
        api.registerMemoryCapability({ runtime, flushPlanResolver });
      },
    });
    const registered = registry.registry.memoryCapabilities[0]!;

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

    setActivePluginRegistry(registry.registry);
    expect(registry.registry.memoryCapabilities).toEqual([registered]);
    const effective = resolveMemoryCapabilityRegistration(registry.registry.memoryCapabilities)!;
    expect(effective.pluginId).toBe("memory-core");
    expect(effective.memorySlotSelected).toBe(true);
    expect(effective.capability.publicArtifacts).toBeUndefined();
    expect(effective.capability.flushPlanResolver?.({ cfg: config })).toBeNull();
    await expect(
      effective.capability.runtime?.getMemorySearchManager({ cfg: config, agentId: "main" }),
    ).resolves.toEqual({ manager: null, error: "missing" });
  });

  it("layers same-plugin public artifacts over its runtime capability", async () => {
    const { config, registry } = createPluginRegistryFixture();
    const runtime = createStubMemoryRuntime();
    const flushPlanResolver = () => null;
    const record = createPluginRecord({
      id: "memory-core",
      name: "Memory Core",
      kind: "memory",
      memorySlotSelected: true,
    });

    registerTestPlugin({
      registry,
      config,
      record,
      register(api) {
        api.registerMemoryCapability({ runtime, flushPlanResolver });
        api.registerMemoryCapability({ publicArtifacts: { listArtifacts: async () => [] } });
      },
    });

    setActivePluginRegistry(registry.registry);
    const effective = resolveMemoryCapabilityRegistration(registry.registry.memoryCapabilities)!;
    expect(effective.pluginId).toBe("memory-core");
    expect(effective.memorySlotSelected).toBe(true);
    expect(effective.capability.flushPlanResolver?.({ cfg: config })).toBeNull();
    await expect(
      effective.capability.runtime?.getMemorySearchManager({ cfg: config, agentId: "main" }),
    ).resolves.toEqual({ manager: null, error: "missing" });
    await expect(
      effective.capability.publicArtifacts?.listArtifacts({ cfg: config }),
    ).resolves.toEqual([]);
  });

  it("keeps last-registration-wins behavior when neither registration owns the slot", () => {
    const runtime = createStubMemoryRuntime();
    const promptBuilder = () => ["replacement prompt"];

    const selected = resolveMemoryCapabilityRegistration([
      { pluginId: "memory-first", capability: { runtime } },
      { pluginId: "memory-second", capability: { promptBuilder } },
    ]);

    expect(selected).toEqual({
      pluginId: "memory-second",
      capability: { promptBuilder },
      memorySlotSelected: undefined,
    });
  });
});

describe("memory sidecar runtime gate", () => {
  /** A dreaming sidecar keeps its consolidation lifecycle but never the indexing runtime. */
  it("keeps the consolidation lifecycle while dropping the indexing runtime for a sidecar", () => {
    const { config, registry } = createPluginRegistryFixture();
    const promptBuilder = () => ["memory prompt"];
    const flushPlanResolver = () => null;

    registerVirtualTestPlugin({
      registry,
      config,
      id: "memory-core",
      name: "Memory Core",
      kind: "memory",
      register(api) {
        api.registerMemoryCapability({
          runtime: createStubMemoryRuntime(),
          promptBuilder,
          flushPlanResolver,
        });
      },
    });

    setActivePluginRegistry(registry.registry);
    const selected = resolveMemoryCapabilityRegistration(registry.registry.memoryCapabilities);
    expect(selected?.capability.runtime).toBeUndefined();
    expect(selected?.capability.promptBuilder?.({ availableTools: new Set() })).toEqual([
      "memory prompt",
    ]);
    expect(selected?.capability.flushPlanResolver?.({ cfg: config })).toBeNull();
    expect(
      registry.registry.diagnostics.filter(
        (d) => d.pluginId === "memory-core" && d.level === "warn",
      ),
    ).toHaveLength(1);
  });

  it("registers an artifact-only sidecar capability unchanged", () => {
    const { config, registry } = createPluginRegistryFixture();

    registerVirtualTestPlugin({
      registry,
      config,
      id: "memory-bridge",
      name: "Memory Bridge",
      kind: "memory",
      register(api) {
        api.registerMemoryCapability({
          publicArtifacts: { listArtifacts: async () => [] },
        });
      },
    });

    setActivePluginRegistry(registry.registry);
    expect(registry.registry.memoryCapabilities).toEqual([
      {
        pluginId: "memory-bridge",
        capability: { publicArtifacts: expect.any(Object) },
        memorySlotSelected: false,
      },
    ]);
    expect(
      registry.registry.diagnostics.filter(
        (d) => d.pluginId === "memory-bridge" && d.level === "warn",
      ),
    ).toHaveLength(0);
  });

  /** Registration order flips when a config-path memory plugin loads before the bundled sidecar. */
  it("keeps the slot owner capability when a later sidecar contributes its consolidation", () => {
    const { config, registry } = createPluginRegistryFixture();
    const runtime = createStubMemoryRuntime();
    const flushPlanResolver = () => null;
    const sidecarPromptBuilder = () => ["sidecar prompt"];

    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "acme-memory",
        name: "Acme Memory",
        kind: "memory",
        memorySlotSelected: true,
      }),
      register(api) {
        api.registerMemoryCapability({ runtime });
      },
    });
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "memory-core",
        name: "Memory Core",
        kind: "memory",
      }),
      register(api) {
        api.registerMemoryCapability({
          promptBuilder: sidecarPromptBuilder,
          flushPlanResolver,
          publicArtifacts: { listArtifacts: async () => [] },
        });
      },
    });

    setActivePluginRegistry(registry.registry);
    const selected = resolveMemoryCapabilityRegistration(registry.registry.memoryCapabilities);
    expect(selected?.pluginId).toBe("acme-memory");
    expect(
      selected?.capability.runtime?.resolveMemoryBackendConfig({ cfg: config, agentId: "main" }),
    ).toEqual({ backend: "builtin" });
    expect(selected?.capability.promptBuilder?.({ availableTools: new Set() })).toEqual([
      "sidecar prompt",
    ]);
    expect(selected?.capability.flushPlanResolver?.({ cfg: config })).toBeNull();
    expect(selected?.memorySlotSelected).toBe(true);
  });

  /** Active Memory grants private-transcript recall by resolved plugin id, so a sidecar's recall declaration must never reach the merged owner capability. */
  it("keeps recall authorization with the slot owner when a sidecar declares it", () => {
    const { config, registry } = createPluginRegistryFixture();

    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "acme-memory",
        name: "Acme Memory",
        kind: "memory",
        memorySlotSelected: true,
      }),
      register(api) {
        api.registerMemoryCapability({ runtime: createStubMemoryRuntime() });
      },
    });
    registerTestPlugin({
      registry,
      config,
      record: createPluginRecord({
        id: "memory-core",
        name: "Memory Core",
        kind: "memory",
      }),
      register(api) {
        api.registerMemoryCapability({
          deterministicRecallToolName: "memory_search",
          supportsPrivateTranscriptRecall: true,
          promptBuilder: () => ["sidecar prompt"],
        });
      },
    });

    setActivePluginRegistry(registry.registry);
    const selected = resolveMemoryCapabilityRegistration(registry.registry.memoryCapabilities);
    expect(selected?.pluginId).toBe("acme-memory");
    expect(selected?.capability.deterministicRecallToolName).toBeUndefined();
    expect(selected?.capability.supportsPrivateTranscriptRecall).toBeUndefined();
    expect(selected?.capability.promptBuilder).toBeDefined();
  });
});
