/** Covers non-activating memory registry handles and requesting-agent workspace ownership. */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type {
  LegacyMemoryReadResult,
  MemoryProviderStatus,
  MemoryReadResult,
  MemorySearchResult,
} from "../memory-host-sdk/host/types.js";
import type {
  MemoryPluginRuntime,
  RegisteredMemorySearchManager,
} from "./registry-contribution-types.js";
import { createEmptyPluginRegistry } from "./registry-empty.js";
import { getPluginRuntimeGatewayRequestScope } from "./runtime/gateway-request-scope.js";

type AuthorizeSearchHits = NonNullable<MemoryPluginRuntime["authorizeSearchHits"]>;

const mocks = vi.hoisted(() => ({
  getMemoryRuntime: vi.fn(),
  loadPluginRegistryHandle: vi.fn(),
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

vi.mock("./memory-state.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./memory-state.js")>();
  return { ...actual, getMemoryRuntime: mocks.getMemoryRuntime };
});

import {
  authorizeActiveMemorySearchHits,
  closeActiveMemorySearchManagerCore,
  closeActiveMemorySearchManagersCore,
  getActiveMemorySearchManagerCore,
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
};

function createRegistry(): TestRegistry<ReturnType<typeof createRuntime>>;
function createRegistry<T extends MemoryPluginRuntime>(runtime: T): TestRegistry<T>;
function createRegistry(
  runtime: MemoryPluginRuntime = createRuntime(),
): TestRegistry<MemoryPluginRuntime> {
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
    mocks.loadPluginRegistryHandle.mockReset();
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

  it("prefers an already-registered runtime", () => {
    const runtime = createRuntime();
    mocks.getMemoryRuntime.mockReturnValue(runtime);

    expect(resolveActiveMemoryBackendConfig({ cfg: memoryConfig, agentId: "main" })).toEqual({
      backend: "builtin",
    });
    expect(mocks.loadPluginRegistryHandle).not.toHaveBeenCalled();
  });

  it("preserves statusless reads as successful while preserving manager lifecycle", async () => {
    const canonicalEmpty = {
      status: "ok",
      text: "",
      path: "memory/canonical-empty.md",
    } as const satisfies MemoryReadResult;
    const canonicalMissing = {
      status: "not_found",
      text: "",
      path: "memory/canonical-missing.md",
    } as const satisfies MemoryReadResult;

    class RegisteredReadManager implements RegisteredMemorySearchManager {
      #closed = false;
      #readCalls = 0;

      async search(): Promise<MemorySearchResult[]> {
        return [];
      }

      async readFile({
        relPath,
      }: {
        relPath: string;
      }): Promise<LegacyMemoryReadResult | MemoryReadResult> {
        this.#readCalls += 1;
        switch (relPath) {
          case "memory/legacy-bare-empty.md":
            return { text: "", path: relPath };
          case "memory/legacy-ranged-empty.md":
            return { text: "", path: relPath, from: 1, lines: 0 };
          case "memory/legacy-nonempty.md":
            return { text: "legacy", path: relPath };
          case canonicalEmpty.path:
            return canonicalEmpty;
          case canonicalMissing.path:
            return canonicalMissing;
          default:
            throw new Error(`unexpected read path: ${relPath}`);
        }
      }

      status(): MemoryProviderStatus {
        return { backend: "builtin", provider: "builtin" };
      }

      async probeEmbeddingAvailability() {
        return { ok: true };
      }

      async probeVectorAvailability() {
        return true;
      }

      async close() {
        this.#closed = true;
      }

      isClosed() {
        return this.#closed;
      }

      readCalls() {
        return this.#readCalls;
      }
    }
    const manager = new RegisteredReadManager();
    const runtime = {
      ...createRuntime(),
      getMemorySearchManager: vi.fn(async () => ({
        manager,
      })),
    } satisfies MemoryPluginRuntime;
    mocks.getMemoryRuntime.mockReturnValue(runtime);

    const first = await getActiveMemorySearchManagerCore({ cfg: memoryConfig, agentId: "main" });
    const second = await getActiveMemorySearchManagerCore({ cfg: memoryConfig, agentId: "main" });

    expect(second.manager).toBe(first.manager);
    expect(Reflect.get(second.manager ?? {}, "readFile")).toBe(
      Reflect.get(first.manager ?? {}, "readFile"),
    );
    await expect(
      first.manager?.readFile({ relPath: "memory/legacy-bare-empty.md" }),
    ).resolves.toEqual({
      status: "ok",
      text: "",
      path: "memory/legacy-bare-empty.md",
    });
    await expect(
      first.manager?.readFile({ relPath: "memory/legacy-ranged-empty.md" }),
    ).resolves.toEqual({
      status: "ok",
      text: "",
      path: "memory/legacy-ranged-empty.md",
      from: 1,
      lines: 0,
    });
    await expect(
      first.manager?.readFile({ relPath: "memory/legacy-nonempty.md" }),
    ).resolves.toEqual({
      status: "ok",
      text: "legacy",
      path: "memory/legacy-nonempty.md",
    });
    await expect(first.manager?.readFile({ relPath: canonicalEmpty.path })).resolves.toBe(
      canonicalEmpty,
    );
    await expect(first.manager?.readFile({ relPath: canonicalMissing.path })).resolves.toBe(
      canonicalMissing,
    );
    await first.manager?.close?.();
    expect(manager.isClosed()).toBe(true);
    expect(manager.readCalls()).toBe(5);
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
