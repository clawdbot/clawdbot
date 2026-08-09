/** Covers non-activating memory registry handles and requesting-agent workspace ownership. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  COMPLETE_MEMORY_AUTHORIZATION_CAPABILITIES,
  LEGACY_MEMORY_AUTHORIZATION_CAPABILITIES,
} from "../memory-host-sdk/host/authorization.js";
import type { MemorySearchResult } from "../memory-host-sdk/host/types.js";
import type { MemoryPluginCapability, MemoryPluginRuntime } from "./registry-contribution-types.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { getPluginRuntimeGatewayRequestScope } from "./runtime/gateway-request-scope.js";

type AuthorizeSearchHits = NonNullable<MemoryPluginRuntime["authorizeSearchHits"]>;

const mocks = vi.hoisted(() => ({
  loadPluginRegistryHandle: vi.fn(),
  logDebug: vi.fn(),
  observeMemoryAuthorizationShadowSurface: vi.fn(),
  requireActivePluginRegistry: vi.fn(),
  resolvePluginRegistryLoadCacheKey: vi.fn((options: unknown) => JSON.stringify(options)),
  resolveAgentWorkspaceDir: vi.fn(),
}));

vi.mock("../agents/agent-scope.js", () => ({
  resolveAgentWorkspaceDir: mocks.resolveAgentWorkspaceDir,
}));

vi.mock("./loader.js", () => ({
  loadPluginRegistryHandle: mocks.loadPluginRegistryHandle,
  resolvePluginRegistryLoadCacheKey: mocks.resolvePluginRegistryLoadCacheKey,
}));

vi.mock("../logging/subsystem.js", () => ({
  createSubsystemLogger: vi.fn(() => ({ debug: mocks.logDebug })),
}));

vi.mock("./memory-authorization-shadow.js", () => ({
  observeMemoryAuthorizationShadowSurface: mocks.observeMemoryAuthorizationShadowSurface,
}));

vi.mock("./runtime.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./runtime.js")>();
  return { ...actual, requireActivePluginRegistry: mocks.requireActivePluginRegistry };
});

import {
  authorizeActiveMemorySearchHits,
  closeActiveMemorySearchManagerCore,
  closeActiveMemorySearchManagersCore,
  getActiveMemorySearchManagerCore,
  getSelectedMemoryRuntime,
  resolveActiveMemoryBackendConfig,
} from "./memory-runtime.js";
import { resetStandaloneMemoryRegistrySlot } from "./memory-runtime.test-support.js";
import { hasMemoryRuntime } from "./memory-state.js";

function createRuntime() {
  return {
    authorizeSearchHits: vi.fn<AuthorizeSearchHits>(async ({ hits }) => hits),
    getMemorySearchManager: vi.fn(async () => ({ manager: null, error: "no index" })),
    resolveMemoryBackendConfig: vi.fn(() => ({ backend: "builtin" as const })),
    closeMemorySearchManager: vi.fn(async () => {}),
    closeAllMemorySearchManagers: vi.fn(async () => {}),
  } satisfies MemoryPluginRuntime;
}

type TestRegistry<T extends MemoryPluginRuntime> = {
  registry: ReturnType<typeof createEmptyPluginRegistry>;
  runtime: T;
  capability: MemoryPluginCapability;
};

function createRegistry(): TestRegistry<ReturnType<typeof createRuntime>>;
function createRegistry<T extends MemoryPluginRuntime>(runtime: T): TestRegistry<T>;
function createRegistry(
  runtime: MemoryPluginRuntime = createRuntime(),
): TestRegistry<MemoryPluginRuntime> {
  const registry = createEmptyPluginRegistry();
  const capability = {
    authorization: LEGACY_MEMORY_AUTHORIZATION_CAPABILITIES,
    runtime,
  } satisfies MemoryPluginCapability;
  registry.plugins.push({ id: "memory-core", memorySlotSelected: true } as never);
  registry.memoryCapabilities.push({ pluginId: "memory-core", capability });
  return { registry, runtime, capability };
}

const memoryConfig = {
  plugins: { slots: { memory: "memory-core" } },
} as never;

describe("memory runtime handles", () => {
  beforeEach(() => {
    resetStandaloneMemoryRegistrySlot();
    mocks.loadPluginRegistryHandle.mockReset();
    mocks.logDebug.mockReset();
    mocks.observeMemoryAuthorizationShadowSurface.mockReset();
    mocks.requireActivePluginRegistry.mockReset().mockReturnValue(createEmptyPluginRegistry());
    mocks.resolvePluginRegistryLoadCacheKey.mockClear();
    mocks.resolveAgentWorkspaceDir
      .mockReset()
      .mockImplementation((_cfg, agentId: string) =>
        agentId === "research" ? "/workspace/research" : "/workspace/main",
      );
  });

  it("loads only the selected memory plugin into a non-activating handle", async () => {
    const { registry, runtime } = createRegistry();
    runtime.getMemorySearchManager.mockImplementationOnce(async () => {
      expect(getPluginRuntimeGatewayRequestScope()?.pluginRegistry).toBe(registry);
      return { manager: null, error: "no index" };
    });
    runtime.resolveMemoryBackendConfig.mockImplementationOnce(() => {
      expect(getPluginRuntimeGatewayRequestScope()?.pluginRegistry).toBe(registry);
      return { backend: "builtin" };
    });
    mocks.loadPluginRegistryHandle.mockReturnValue(registry);

    await expect(
      getActiveMemorySearchManagerCore({ cfg: memoryConfig, agentId: "main" }),
    ).resolves.toEqual({ manager: null, error: "no index" });

    expect(mocks.loadPluginRegistryHandle).toHaveBeenCalledWith({
      activate: false,
      config: memoryConfig,
      onlyPluginIds: ["memory-core"],
      workspaceDir: "/workspace/main",
    });
    expect(runtime.getMemorySearchManager).toHaveBeenCalledWith({
      cfg: memoryConfig,
      agentId: "main",
    });
    expect(resolveActiveMemoryBackendConfig({ cfg: memoryConfig, agentId: "main" })).toEqual({
      backend: "builtin",
    });
  });

  it("tracks standalone managers without activating config-only lookups and rearms reused handles", async () => {
    const { registry, runtime } = createRegistry();
    mocks.loadPluginRegistryHandle.mockReturnValue(registry);

    expect(hasMemoryRuntime()).toBe(false);
    expect(resolveActiveMemoryBackendConfig({ cfg: memoryConfig, agentId: "main" })).toEqual({
      backend: "builtin",
    });
    expect(hasMemoryRuntime()).toBe(false);

    await getActiveMemorySearchManagerCore({ cfg: memoryConfig, agentId: "main" });
    expect(hasMemoryRuntime()).toBe(true);

    await closeActiveMemorySearchManagersCore();
    expect(hasMemoryRuntime()).toBe(false);

    await getActiveMemorySearchManagerCore({ cfg: memoryConfig, agentId: "main" });
    expect(hasMemoryRuntime()).toBe(true);
    expect(mocks.loadPluginRegistryHandle).toHaveBeenCalledTimes(1);

    await closeActiveMemorySearchManagersCore();
    expect(runtime.closeAllMemorySearchManagers).toHaveBeenCalledTimes(2);
    expect(hasMemoryRuntime()).toBe(false);
  });

  it("retains standalone ownership across workspace replacement and per-agent cleanup", async () => {
    const main = createRegistry();
    const research = createRegistry();
    mocks.loadPluginRegistryHandle
      .mockReturnValueOnce(main.registry)
      .mockReturnValueOnce(research.registry);

    await getActiveMemorySearchManagerCore({ cfg: memoryConfig, agentId: "main" });
    await getActiveMemorySearchManagerCore({ cfg: memoryConfig, agentId: "research" });
    expect(hasMemoryRuntime()).toBe(true);

    await closeActiveMemorySearchManagerCore({ cfg: memoryConfig, agentId: "main" });
    expect(hasMemoryRuntime()).toBe(true);

    await closeActiveMemorySearchManagersCore();
    expect(main.runtime.closeAllMemorySearchManagers).toHaveBeenCalledTimes(1);
    expect(research.runtime.closeAllMemorySearchManagers).toHaveBeenCalledTimes(1);
    expect(hasMemoryRuntime()).toBe(false);
  });

  it("retains standalone cleanup ownership when manager acquisition or teardown fails", async () => {
    const { registry, runtime } = createRegistry();
    mocks.loadPluginRegistryHandle.mockReturnValue(registry);
    runtime.getMemorySearchManager.mockRejectedValueOnce(
      new Error("manager initialization failed"),
    );

    await expect(
      getActiveMemorySearchManagerCore({ cfg: memoryConfig, agentId: "main" }),
    ).rejects.toThrow("manager initialization failed");
    expect(hasMemoryRuntime()).toBe(true);

    runtime.closeAllMemorySearchManagers.mockRejectedValueOnce(
      new Error("manager teardown failed"),
    );
    await expect(closeActiveMemorySearchManagersCore()).rejects.toThrow("manager teardown failed");
    expect(hasMemoryRuntime()).toBe(true);

    await closeActiveMemorySearchManagersCore();
    expect(hasMemoryRuntime()).toBe(false);
  });

  it("keys the single slot by the requesting agent workspace", () => {
    const main = createRegistry();
    const research = createRegistry();
    mocks.loadPluginRegistryHandle
      .mockReturnValueOnce(main.registry)
      .mockReturnValueOnce(research.registry);

    expect(resolveActiveMemoryBackendConfig({ cfg: memoryConfig, agentId: "main" })).toEqual({
      backend: "builtin",
    });
    expect(resolveActiveMemoryBackendConfig({ cfg: memoryConfig, agentId: "main" })).toEqual({
      backend: "builtin",
    });
    expect(resolveActiveMemoryBackendConfig({ cfg: memoryConfig, agentId: "research" })).toEqual({
      backend: "builtin",
    });

    expect(mocks.resolveAgentWorkspaceDir).toHaveBeenNthCalledWith(1, memoryConfig, "main");
    expect(mocks.resolveAgentWorkspaceDir).toHaveBeenLastCalledWith(memoryConfig, "research");
    expect(mocks.loadPluginRegistryHandle).toHaveBeenCalledTimes(2);
  });

  it.each([
    { plugins: { enabled: false } },
    { plugins: { slots: { memory: "none" } } },
    { plugins: { slots: { memory: "memory-core" }, deny: ["memory-core"] } },
    {
      plugins: {
        slots: { memory: "memory-core" },
        entries: { "memory-core": { enabled: false } },
      },
    },
  ])("does not load a disabled memory selection", async (cfg) => {
    await expect(
      getActiveMemorySearchManagerCore({ cfg: cfg as never, agentId: "main" }),
    ).resolves.toEqual({ manager: null, error: "memory plugin unavailable" });
    expect(mocks.loadPluginRegistryHandle).not.toHaveBeenCalled();
  });

  it("prefers an already-registered selected capability runtime", () => {
    const { registry } = createRegistry();
    mocks.requireActivePluginRegistry.mockReturnValue(registry);

    expect(resolveActiveMemoryBackendConfig({ cfg: memoryConfig, agentId: "main" })).toEqual({
      backend: "builtin",
    });
    expect(mocks.loadPluginRegistryHandle).not.toHaveBeenCalled();
  });

  it("inspects direct selected capability resolution through the canonical seam", () => {
    const { registry, runtime } = createRegistry();
    mocks.requireActivePluginRegistry.mockReturnValue(registry);

    expect(getSelectedMemoryRuntime()).toBe(runtime);
    expect(mocks.observeMemoryAuthorizationShadowSurface).toHaveBeenCalledOnce();
    expect(mocks.observeMemoryAuthorizationShadowSurface).toHaveBeenCalledWith({
      capability: expect.objectContaining({
        authorization: LEGACY_MEMORY_AUTHORIZATION_CAPABILITIES,
        runtime,
      }),
      registry,
    });
  });

  it("wires each legacy resolution through shadow inspection without changing legacy resolution", () => {
    const { registry, runtime } = createRegistry();
    mocks.loadPluginRegistryHandle.mockReturnValue(registry);

    expect(resolveActiveMemoryBackendConfig({ cfg: memoryConfig, agentId: "main" })).toEqual({
      backend: "builtin",
    });
    expect(resolveActiveMemoryBackendConfig({ cfg: memoryConfig, agentId: "main" })).toEqual({
      backend: "builtin",
    });

    expect(mocks.observeMemoryAuthorizationShadowSurface).toHaveBeenCalledTimes(2);
    expect(mocks.observeMemoryAuthorizationShadowSurface).toHaveBeenCalledWith({
      capability: expect.objectContaining({
        authorization: LEGACY_MEMORY_AUTHORIZATION_CAPABILITIES,
        runtime,
      }),
      registry,
    });
    expect(runtime.resolveMemoryBackendConfig).toHaveBeenCalledTimes(2);
  });

  it("observes a selected runtime-less capability without inventing a runtime", () => {
    const registry = createEmptyPluginRegistry();
    registry.plugins.push({ id: "memory-lancedb", memorySlotSelected: true } as never);
    registry.memoryCapabilities.push({
      pluginId: "memory-lancedb",
      capability: { authorization: LEGACY_MEMORY_AUTHORIZATION_CAPABILITIES },
    });
    mocks.requireActivePluginRegistry.mockReturnValue(registry);

    expect(getSelectedMemoryRuntime()).toBeUndefined();
    expect(mocks.observeMemoryAuthorizationShadowSurface).toHaveBeenCalledWith({
      capability: expect.objectContaining({
        authorization: LEGACY_MEMORY_AUTHORIZATION_CAPABILITIES,
      }),
      registry,
    });
  });

  it("observes selected authorization when it inherits a sidecar runtime", () => {
    const registry = createEmptyPluginRegistry();
    const runtime = createRuntime();
    registry.plugins.push({ id: "memory-lancedb", memorySlotSelected: true } as never);
    registry.memoryCapabilities.push(
      {
        pluginId: "memory-core",
        capability: {
          authorization: COMPLETE_MEMORY_AUTHORIZATION_CAPABILITIES,
          runtime,
        },
      },
      {
        pluginId: "memory-lancedb",
        capability: {
          authorization: LEGACY_MEMORY_AUTHORIZATION_CAPABILITIES,
          publicArtifacts: { listArtifacts: async () => [] },
        },
      },
    );
    mocks.requireActivePluginRegistry.mockReturnValue(registry);

    expect(getSelectedMemoryRuntime()).toBe(runtime);
    expect(mocks.observeMemoryAuthorizationShadowSurface).toHaveBeenCalledWith({
      capability: expect.objectContaining({
        authorization: LEGACY_MEMORY_AUTHORIZATION_CAPABILITIES,
        runtime,
      }),
      registry,
    });
  });

  it("keeps legacy resolution when shadow logging fails", () => {
    const { registry, runtime } = createRegistry();
    mocks.loadPluginRegistryHandle.mockReturnValue(registry);
    mocks.observeMemoryAuthorizationShadowSurface.mockReturnValue({ mode: "shadow" });
    mocks.logDebug.mockImplementation(() => {
      throw new Error("logger unavailable");
    });

    expect(resolveActiveMemoryBackendConfig({ cfg: memoryConfig, agentId: "main" })).toEqual({
      backend: "builtin",
    });
    expect(runtime.resolveMemoryBackendConfig).toHaveBeenCalledTimes(1);
  });

  it("authorizes raw hits inside the selected plugin runtime scope", async () => {
    const { registry, runtime } = createRegistry();
    runtime.authorizeSearchHits.mockImplementationOnce(async ({ hits }) => {
      expect(getPluginRuntimeGatewayRequestScope()?.pluginRegistry).toBe(registry);
      return hits.filter((hit) => hit.source === "memory");
    });
    mocks.loadPluginRegistryHandle.mockReturnValue(registry);
    const hits: MemorySearchResult[] = [
      {
        source: "memory",
        path: "memory.md",
        startLine: 1,
        endLine: 1,
        score: 1,
        snippet: "memory",
      },
      {
        source: "sessions",
        path: "sessions/private.jsonl",
        startLine: 1,
        endLine: 1,
        score: 1,
        snippet: "private",
      },
    ];

    await expect(
      authorizeActiveMemorySearchHits({
        cfg: memoryConfig,
        agentId: "main",
        requesterSessionKey: "agent:main:voice:15550001234",
        sandboxed: false,
        hits,
      }),
    ).resolves.toEqual([hits[0]]);
  });

  it("fails closed on session hits when a memory runtime has no authorizer", async () => {
    const runtimeWithoutAuthorizer = {
      getMemorySearchManager: vi.fn(async () => ({ manager: null, error: "no index" })),
      resolveMemoryBackendConfig: vi.fn(() => ({ backend: "builtin" as const })),
      closeMemorySearchManager: vi.fn(async () => {}),
      closeAllMemorySearchManagers: vi.fn(async () => {}),
    } satisfies MemoryPluginRuntime;
    mocks.loadPluginRegistryHandle.mockReturnValue(
      createRegistry(runtimeWithoutAuthorizer).registry,
    );
    const hits: MemorySearchResult[] = [
      {
        source: "memory",
        path: "memory.md",
        startLine: 1,
        endLine: 1,
        score: 1,
        snippet: "memory",
      },
      {
        source: "sessions",
        path: "sessions/private.jsonl",
        startLine: 1,
        endLine: 1,
        score: 1,
        snippet: "private",
      },
    ];

    await expect(
      authorizeActiveMemorySearchHits({
        cfg: memoryConfig,
        agentId: "main",
        requesterSessionKey: "agent:main:voice:15550001234",
        sandboxed: false,
        hits,
      }),
    ).resolves.toEqual([hits[0]]);
  });

  it("closes managers through current and retired workspace handles without reloading", async () => {
    const main = createRegistry();
    const research = createRegistry();
    for (const owner of [main, research]) {
      owner.runtime.closeMemorySearchManager.mockImplementationOnce(async () => {
        expect(getPluginRuntimeGatewayRequestScope()?.pluginRegistry).toBe(owner.registry);
      });
      owner.runtime.closeAllMemorySearchManagers.mockImplementationOnce(async () => {
        expect(getPluginRuntimeGatewayRequestScope()?.pluginRegistry).toBe(owner.registry);
      });
    }
    mocks.loadPluginRegistryHandle
      .mockReturnValueOnce(main.registry)
      .mockReturnValueOnce(research.registry);
    resolveActiveMemoryBackendConfig({ cfg: memoryConfig, agentId: "main" });
    resolveActiveMemoryBackendConfig({ cfg: memoryConfig, agentId: "research" });
    mocks.loadPluginRegistryHandle.mockClear();

    await closeActiveMemorySearchManagerCore({ cfg: memoryConfig, agentId: "main" });
    await closeActiveMemorySearchManagersCore(memoryConfig);

    for (const { runtime } of [main, research]) {
      expect(runtime.closeMemorySearchManager).toHaveBeenCalledWith({
        cfg: memoryConfig,
        agentId: "main",
      });
      expect(runtime.closeAllMemorySearchManagers).toHaveBeenCalledTimes(1);
    }
    expect(mocks.loadPluginRegistryHandle).not.toHaveBeenCalled();
  });
});
