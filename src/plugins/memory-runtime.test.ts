/** Covers non-activating memory registry handles and requesting-agent workspace ownership. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { getPluginRuntimeGatewayRequestScope } from "./runtime/gateway-request-scope.js";

const mocks = vi.hoisted(() => ({
  getMemoryRuntime: vi.fn(),
  loadRuntimePluginRegistryHandle: vi.fn(),
  resolveAgentWorkspaceDir: vi.fn(),
}));

vi.mock("../agents/agent-scope.js", () => ({
  resolveAgentWorkspaceDir: mocks.resolveAgentWorkspaceDir,
}));

vi.mock("./runtime/standalone-runtime-registry-loader.js", () => ({
  loadRuntimePluginRegistryHandle: mocks.loadRuntimePluginRegistryHandle,
}));

vi.mock("./memory-state.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./memory-state.js")>();
  return { ...actual, getMemoryRuntime: mocks.getMemoryRuntime };
});

import {
  closeActiveMemorySearchManager,
  closeActiveMemorySearchManagers,
  getActiveMemorySearchManager,
  resolveActiveMemoryBackendConfig,
} from "./memory-runtime.js";
import { resetStandaloneMemoryRegistrySlot } from "./memory-runtime.test-support.js";

function createRuntime() {
  return {
    getMemorySearchManager: vi.fn(async () => ({ manager: null, error: "no index" })),
    resolveMemoryBackendConfig: vi.fn(() => ({ backend: "builtin" as const })),
    closeMemorySearchManager: vi.fn(async () => {}),
    closeAllMemorySearchManagers: vi.fn(async () => {}),
  };
}

function createRegistry(runtime = createRuntime()) {
  const registry = createEmptyPluginRegistry();
  registry.memoryCapabilities.push({ pluginId: "memory-core", capability: { runtime } });
  return { registry, runtime };
}

const memoryConfig = {
  plugins: { slots: { memory: "memory-core" } },
} as never;

describe("memory runtime handles", () => {
  beforeEach(() => {
    resetStandaloneMemoryRegistrySlot();
    mocks.getMemoryRuntime.mockReset().mockReturnValue(undefined);
    mocks.loadRuntimePluginRegistryHandle.mockReset();
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
    mocks.loadRuntimePluginRegistryHandle.mockReturnValue(registry);

    await expect(
      getActiveMemorySearchManager({ cfg: memoryConfig, agentId: "main" }),
    ).resolves.toEqual({ manager: null, error: "no index" });

    expect(mocks.loadRuntimePluginRegistryHandle).toHaveBeenCalledWith({
      requiredPluginIds: ["memory-core"],
      loadOptions: {
        activate: false,
        config: memoryConfig,
        onlyPluginIds: ["memory-core"],
        workspaceDir: "/workspace/main",
      },
    });
    expect(runtime.getMemorySearchManager).toHaveBeenCalledWith({
      cfg: memoryConfig,
      agentId: "main",
    });
    expect(resolveActiveMemoryBackendConfig({ cfg: memoryConfig, agentId: "main" })).toEqual({
      backend: "builtin",
    });
  });

  it("keys the single slot by the requesting agent workspace", () => {
    const main = createRegistry();
    const research = createRegistry();
    mocks.loadRuntimePluginRegistryHandle
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
    expect(mocks.loadRuntimePluginRegistryHandle).toHaveBeenCalledTimes(2);
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
      getActiveMemorySearchManager({ cfg: cfg as never, agentId: "main" }),
    ).resolves.toEqual({ manager: null, error: "memory plugin unavailable" });
    expect(mocks.loadRuntimePluginRegistryHandle).not.toHaveBeenCalled();
  });

  it("prefers an already-registered runtime", () => {
    const runtime = createRuntime();
    mocks.getMemoryRuntime.mockReturnValue(runtime);

    expect(resolveActiveMemoryBackendConfig({ cfg: memoryConfig, agentId: "main" })).toEqual({
      backend: "builtin",
    });
    expect(mocks.loadRuntimePluginRegistryHandle).not.toHaveBeenCalled();
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
    mocks.loadRuntimePluginRegistryHandle
      .mockReturnValueOnce(main.registry)
      .mockReturnValueOnce(research.registry);
    resolveActiveMemoryBackendConfig({ cfg: memoryConfig, agentId: "main" });
    resolveActiveMemoryBackendConfig({ cfg: memoryConfig, agentId: "research" });
    mocks.loadRuntimePluginRegistryHandle.mockClear();

    await closeActiveMemorySearchManager({ cfg: memoryConfig, agentId: "main" });
    await closeActiveMemorySearchManagers(memoryConfig);

    for (const { runtime } of [main, research]) {
      expect(runtime.closeMemorySearchManager).toHaveBeenCalledWith({
        cfg: memoryConfig,
        agentId: "main",
      });
      expect(runtime.closeAllMemorySearchManagers).toHaveBeenCalledTimes(1);
    }
    expect(mocks.loadRuntimePluginRegistryHandle).not.toHaveBeenCalled();
  });
});
