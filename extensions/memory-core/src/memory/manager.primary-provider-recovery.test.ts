// Memory Core tests cover primary provider recovery after fallback activation.
import type { DatabaseSync } from "node:sqlite";
import type {
  OpenClawConfig,
  ResolvedMemorySearchConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { hashText } from "openclaw/plugin-sdk/memory-core-host-engine-storage";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { EmbeddingProvider } from "./embeddings.js";
import { MemoryIndexManager } from "./manager.js";

type ProviderCall = {
  provider?: string;
  model?: string;
  fallback?: string;
};

const providerState = vi.hoisted(() => ({
  calls: [] as ProviderCall[],
  embedQueryCalls: 0,
  embedBatchCalls: 0,
  creationFailure: null as string | null,
  embedQueryFailure: false,
  embedQueryGate: null as Promise<void> | null,
  providerCloseCalls: 0,
  providerCloseGate: null as Promise<void> | null,
}));

const primaryProviderKey = hashText(JSON.stringify({ provider: "mock", model: "mock-embed" }));

vi.mock("./embeddings.js", () => ({
  resolveEmbeddingProviderAdapterId: (providerId: string) => providerId,
  resolveEmbeddingProviderAdapterTransport: (providerId: string) =>
    providerId === "local" ? "local" : "remote",
  resolveEmbeddingProviderFallbackModel: (providerId: string, fallbackSourceModel: string) =>
    providerId === "fallback-provider" ? "fallback-provider-embed" : fallbackSourceModel,
  resolveEmbeddingProviderIndexIdentity: () => undefined,
  createEmbeddingProvider: async (options: {
    provider?: string;
    model?: string;
    fallback?: string;
  }) => {
    providerState.calls.push({
      provider: options.provider,
      model: options.model,
      fallback: options.fallback,
    });
    if (options.provider === providerState.creationFailure) {
      throw new Error(`provider creation failed: ${options.provider}`);
    }
    const providerId = options.provider === "fallback-provider" ? "fallback-provider" : "mock";
    const model = providerId === "fallback-provider" ? "fallback-provider-embed" : "mock-embed";
    return {
      requestedProvider: options.provider ?? "openai",
      provider: {
        id: providerId,
        model,
        close: async () => {
          providerState.providerCloseCalls += 1;
          await providerState.providerCloseGate;
        },
        embedQuery: async (_text: string, callOptions?: { signal?: AbortSignal }) => {
          providerState.embedQueryCalls += 1;
          await providerState.embedQueryGate;
          if (providerState.embedQueryFailure) {
            throw new Error("primary provider probe failed");
          }
          const signal = callOptions?.signal;
          if (signal?.aborted) {
            const reason = signal.reason;
            throw reason instanceof Error ? reason : new Error("embedding aborted");
          }
          return [1, 0, 0, 0];
        },
        embedBatch: async (_texts: string[]) => {
          providerState.embedBatchCalls += 1;
          return [[1, 0, 0, 0]];
        },
      },
    };
  },
}));

type RecoveryHarness = {
  activeManagerOperations: number;
  managerIdleWaiters: Set<() => void>;
  managerExclusivePromise: Promise<void> | null;
  closing: boolean;
  closed: boolean;
  fallbackFrom?: string;
  fallbackReason?: string;
  lastPrimaryRecoveryAttemptMs: number;
  primaryProviderRecoveryPromise: Promise<{ provider: EmbeddingProvider } | null> | null;
  primaryProviderRecoveryBackgroundPromise: Promise<void> | null;
  providerInitialized: boolean;
  providerLifecycle: unknown;
  provider: EmbeddingProvider | null;
  providerRuntime?: unknown;
  providerKey: string;
  batch: unknown;
  db: DatabaseSync;
  fts: { available: boolean };
  vector: { available: boolean };
  vectorReady: Promise<boolean> | null;
  attemptPrimaryProviderRecovery: (params: {
    force?: boolean;
    signal?: AbortSignal;
  }) => Promise<{ provider: EmbeddingProvider } | null>;
  computeProviderKey: () => string;
  resolveBatchConfig: () => unknown;
  retireProvider: (provider: EmbeddingProvider) => Promise<void>;
  awaitManagerIdle: () => Promise<void>;
  refreshIndexIdentityDirty: () => { status: string };
  readMeta: () => {
    provider?: string;
    model?: string;
    providerKey?: string;
  } | null;
  schedulePrimaryProviderRecovery: () => void;
  syncAdmitted: (...args: unknown[]) => Promise<void>;
  getActivePrimaryRecoveryBuildSnapshot: () => unknown;
};

function createProvider(id: string): EmbeddingProvider {
  return {
    id,
    model: id === "fallback-provider" ? "fallback-provider-embed" : "mock-embed",
    close: async () => {},
    embedQuery: async () => [1, 0, 0, 0],
    embedBatch: async () => [[1, 0, 0, 0]],
  };
}

function createSettings(): ResolvedMemorySearchConfig {
  return {
    provider: "openai",
    model: "mock-embed",
    fallback: "fallback-provider",
    remote: undefined,
    outputDimensionality: undefined,
    inputType: undefined,
    queryInputType: undefined,
    documentInputType: undefined,
    local: undefined,
    sync: { embeddingBatchTimeoutSeconds: undefined },
  } as unknown as ResolvedMemorySearchConfig;
}

function createPrimaryMeta() {
  return {
    provider: "mock",
    model: "mock-embed",
    providerKey: primaryProviderKey,
  };
}

function createRecoveryHarness(): RecoveryHarness {
  const fallbackProvider = createProvider("fallback-provider");
  const manager = Object.assign(Object.create(MemoryIndexManager.prototype), {
    cfg: {} as OpenClawConfig,
    agentId: "main",
    settings: createSettings(),
    acquireLocalService: undefined,
    activeManagerOperations: 0,
    managerIdleWaiters: new Set<() => void>(),
    managerExclusivePromise: null,
    closing: false,
    closed: false,
    fallbackFrom: "mock",
    fallbackReason: "primary provider failed",
    lastPrimaryRecoveryAttemptMs: 0,
    primaryProviderRecoveryPromise: null,
    primaryProviderRecoveryBackgroundPromise: null,
    providerInitialized: true,
    providerLifecycle: {
      mode: "fallback-active",
      providerId: "fallback-provider",
      fallbackFrom: "mock",
      reason: "primary provider failed",
    },
    provider: fallbackProvider,
    providerRuntime: undefined,
    providerKey: "fallback-provider-key",
    batch: {},
    cacheKey: "test-cache-key",
    db: {} as DatabaseSync,
    fts: { available: true },
    vector: { available: true },
    vectorReady: null,
    computeProviderKey: vi.fn(() => "mock-provider-key"),
    resolveBatchConfig: vi.fn(() => ({ enabled: false })),
    retireProvider: vi.fn(async () => {}),
    refreshIndexIdentityDirty: vi.fn(() => ({ status: "valid" })),
    readMeta: vi.fn(() => null),
    syncAdmitted: vi.fn(async () => {}),
  }) as RecoveryHarness;
  return manager;
}

describe("memory manager primary provider recovery", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  beforeEach(() => {
    providerState.calls = [];
    providerState.embedQueryCalls = 0;
    providerState.embedBatchCalls = 0;
    providerState.creationFailure = null;
    providerState.embedQueryFailure = false;
    providerState.embedQueryGate = null;
    providerState.providerCloseCalls = 0;
    providerState.providerCloseGate = null;
  });

  it("probes the configured primary without touching the active fallback provider", async () => {
    const manager = createRecoveryHarness();
    const fallbackProvider = manager.provider;

    const probe = await manager.attemptPrimaryProviderRecovery({});

    expect(probe).not.toBeNull();
    expect(probe?.provider.id).toBe("mock");
    expect(providerState.calls).toEqual([
      { provider: "openai", model: "mock-embed", fallback: "none" },
    ]);
    expect(providerState.embedQueryCalls).toBe(1);
    expect(providerState.embedBatchCalls).toBe(0);
    expect(manager.provider).toBe(fallbackProvider);
    expect(manager.fallbackFrom).toBe("mock");
    expect(manager.retireProvider).not.toHaveBeenCalled();
  });

  it("restores the configured primary and retires the fallback after a valid shadow build", async () => {
    const manager = createRecoveryHarness();
    const fallbackProvider = manager.provider;
    manager.syncAdmitted = vi.fn(async () => {
      manager.readMeta = vi.fn(() => createPrimaryMeta());
    });

    manager.schedulePrimaryProviderRecovery();
    const backgroundRecovery = manager.primaryProviderRecoveryBackgroundPromise;
    expect(backgroundRecovery).toBeDefined();
    await backgroundRecovery;

    expect(manager.syncAdmitted).toHaveBeenCalledTimes(1);
    expect(manager.syncAdmitted).toHaveBeenCalledWith(
      { reason: "search", force: true },
      {
        suppressFallbackActivation: true,
        providerGeneration: expect.objectContaining({
          provider: expect.objectContaining({ id: "mock" }),
        }),
      },
    );
    expect(manager.provider?.id).toBe("mock");
    expect(manager.fallbackFrom).toBeUndefined();
    expect(manager.providerKey).toBe("mock-provider-key");
    expect(manager.retireProvider).toHaveBeenCalledWith(fallbackProvider);
    expect(manager.lastPrimaryRecoveryAttemptMs).toBe(0);
  });

  it("queues a fresh primary reindex after joining an in-flight fallback sync", async () => {
    const manager = createRecoveryHarness();
    let syncCallCount = 0;
    manager.syncAdmitted = vi.fn(async () => {
      syncCallCount += 1;
      if (syncCallCount >= 2) {
        manager.readMeta = vi.fn(() => createPrimaryMeta());
      }
    });

    manager.schedulePrimaryProviderRecovery();
    await manager.primaryProviderRecoveryBackgroundPromise;

    expect(manager.syncAdmitted).toHaveBeenCalledTimes(2);
    expect(manager.provider?.id).toBe("mock");
    expect(manager.fallbackFrom).toBeUndefined();
  });

  it("admits fallback searches while the recovery reindex builds the shadow index", async () => {
    const manager = createRecoveryHarness();
    const runtimeManager = manager as unknown as {
      withManagerOperation<T>(run: () => Promise<T>): Promise<T>;
    };
    let releaseBuild: () => void = () => {};
    const buildGate = new Promise<void>((resolve) => {
      releaseBuild = resolve;
    });
    manager.syncAdmitted = vi.fn(async () => {
      await buildGate;
      manager.readMeta = vi.fn(() => createPrimaryMeta());
    });

    manager.schedulePrimaryProviderRecovery();
    await vi.waitFor(() => expect(manager.getActivePrimaryRecoveryBuildSnapshot()).not.toBeNull());

    let searchEntered = false;
    const search = runtimeManager.withManagerOperation(async () => {
      searchEntered = true;
    });
    await vi.waitFor(() => expect(searchEntered).toBe(true));
    await search;
    expect(manager.getActivePrimaryRecoveryBuildSnapshot()).not.toBeNull();

    releaseBuild();
    await manager.primaryProviderRecoveryBackgroundPromise;

    expect(manager.getActivePrimaryRecoveryBuildSnapshot()).toBeNull();
    expect(manager.provider?.id).toBe("mock");
    expect(manager.fallbackFrom).toBeUndefined();
  });

  it("serializes only the provider/index cutover through the manager exclusive operation", async () => {
    const manager = createRecoveryHarness();
    const runtimeManager = manager as unknown as {
      withManagerOperation<T>(run: () => Promise<T>): Promise<T>;
      withManagerExclusiveOperation<T>(run: () => Promise<T>): Promise<T>;
    };
    let releaseSearch: () => void = () => {};
    let searchEntered = false;
    let exclusiveEntered = false;
    let lateSearchEntered = false;
    const searchGate = new Promise<void>((resolve) => {
      releaseSearch = resolve;
    });

    const activeSearch = runtimeManager.withManagerOperation(async () => {
      searchEntered = true;
      await searchGate;
    });
    await vi.waitFor(() => expect(searchEntered).toBe(true));

    const cutover = runtimeManager.withManagerExclusiveOperation(async () => {
      exclusiveEntered = true;
    });
    const lateSearch = runtimeManager.withManagerOperation(async () => {
      lateSearchEntered = true;
    });
    await Promise.resolve();
    expect(exclusiveEntered).toBe(false);
    expect(lateSearchEntered).toBe(false);

    releaseSearch();
    await activeSearch;
    await cutover;
    await lateSearch;
    expect(exclusiveEntered).toBe(true);
    expect(lateSearchEntered).toBe(true);
  });

  it("keeps the fallback active when the shadow build cannot produce a primary index", async () => {
    const manager = createRecoveryHarness();
    const fallbackProvider = manager.provider;
    manager.readMeta = vi.fn(() => ({
      provider: "fallback-provider",
      model: "fallback-provider-embed",
      providerKey: "fallback-provider-key",
    }));

    manager.schedulePrimaryProviderRecovery();
    const backgroundRecovery = manager.primaryProviderRecoveryBackgroundPromise;
    expect(backgroundRecovery).toBeDefined();
    await backgroundRecovery;

    expect(manager.provider).toBe(fallbackProvider);
    expect(manager.provider?.id).toBe("fallback-provider");
    expect(manager.fallbackFrom).toBe("mock");
    expect(manager.retireProvider).toHaveBeenCalledWith(expect.objectContaining({ id: "mock" }));
    expect(manager.retireProvider).not.toHaveBeenCalledWith(fallbackProvider);
  });

  it("does not retire the active fallback when the cutover re-check fails", async () => {
    const manager = createRecoveryHarness();
    const fallbackProvider = manager.provider;
    let metaReadCount = 0;
    const fallbackMeta = {
      provider: "fallback-provider",
      model: "fallback-provider-embed",
      providerKey: "fallback-provider-key",
    };
    manager.readMeta = vi.fn(() => {
      metaReadCount += 1;
      return metaReadCount === 1 ? createPrimaryMeta() : fallbackMeta;
    });

    manager.schedulePrimaryProviderRecovery();
    await manager.primaryProviderRecoveryBackgroundPromise;

    expect(manager.provider).toBe(fallbackProvider);
    expect(manager.fallbackFrom).toBe("mock");
    expect(manager.retireProvider).toHaveBeenCalledWith(expect.objectContaining({ id: "mock" }));
    expect(manager.retireProvider).not.toHaveBeenCalledWith(fallbackProvider);
  });

  it("retains the recovery throttle when the shadow build cannot produce a primary index", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    const manager = createRecoveryHarness();
    const fallbackProvider = manager.provider;
    manager.readMeta = vi.fn(() => null);

    manager.schedulePrimaryProviderRecovery();
    await manager.primaryProviderRecoveryBackgroundPromise;

    expect(manager.provider).toBe(fallbackProvider);
    expect(providerState.calls).toEqual([
      { provider: "openai", model: "mock-embed", fallback: "none" },
    ]);
    expect(providerState.embedQueryCalls).toBe(1);
    expect(manager.lastPrimaryRecoveryAttemptMs).toBe(1_000);

    vi.setSystemTime(10_000);
    manager.schedulePrimaryProviderRecovery();
    await manager.primaryProviderRecoveryBackgroundPromise;

    expect(manager.provider).toBe(fallbackProvider);
    expect(providerState.calls).toEqual([
      { provider: "openai", model: "mock-embed", fallback: "none" },
    ]);
    expect(providerState.embedQueryCalls).toBe(1);
    expect(manager.lastPrimaryRecoveryAttemptMs).toBe(1_000);
  });

  it("does not retire a recovered primary when a stale sync fails", async () => {
    const manager = createRecoveryHarness();
    const fallbackProvider = manager.provider;
    // The sync captured the fallback provider in its generation; primary
    // recovery has since promoted a different primary instance in flight.
    const recoveredPrimary = createProvider("mock");
    const managerWithSync = manager as unknown as {
      syncProviderGeneration: { provider: EmbeddingProvider } | null;
      endSyncProviderGeneration: () => void;
      activateFallbackProvider: (reason: string) => Promise<boolean>;
      activateFallbackForSync: (reason: string) => Promise<string>;
    };
    managerWithSync.syncProviderGeneration = { provider: fallbackProvider! };
    managerWithSync.endSyncProviderGeneration = vi.fn();
    managerWithSync.activateFallbackProvider = vi.fn(async () => true);
    manager.provider = recoveredPrimary;

    const result = await managerWithSync.activateFallbackForSync("stale sync failure");

    expect(result).toBe("suppressed");
    expect(managerWithSync.endSyncProviderGeneration).toHaveBeenCalledTimes(1);
    expect(managerWithSync.activateFallbackProvider).not.toHaveBeenCalled();
    expect(manager.provider).toBe(recoveredPrimary);
  });

  it("activates fallback for a sync when the provider is still current", async () => {
    const manager = createRecoveryHarness();
    const fallbackProvider = manager.provider;
    const managerWithSync = manager as unknown as {
      syncProviderGeneration: { provider: EmbeddingProvider } | null;
      endSyncProviderGeneration: () => void;
      activateFallbackProvider: (reason: string) => Promise<boolean>;
      activateFallbackForSync: (reason: string) => Promise<string>;
    };
    managerWithSync.syncProviderGeneration = { provider: fallbackProvider! };
    managerWithSync.endSyncProviderGeneration = vi.fn();
    managerWithSync.activateFallbackProvider = vi.fn(async () => true);

    const result = await managerWithSync.activateFallbackForSync("sync failure");

    expect(result).toBe("activated");
    expect(managerWithSync.activateFallbackProvider).toHaveBeenCalledWith("sync failure");
  });

  it("serializes overlapping primary recovery probes", async () => {
    const manager = createRecoveryHarness();
    let releaseEmbeddingPing: () => void = () => {};
    providerState.embedQueryGate = new Promise<void>((resolve) => {
      releaseEmbeddingPing = resolve;
    });

    const firstRecovery = manager.attemptPrimaryProviderRecovery({});
    await vi.waitFor(() => expect(providerState.embedQueryCalls).toBe(1));
    const secondRecovery = manager.attemptPrimaryProviderRecovery({});

    expect(providerState.calls).toEqual([
      { provider: "openai", model: "mock-embed", fallback: "none" },
    ]);
    expect(providerState.embedQueryCalls).toBe(1);
    expect(providerState.embedBatchCalls).toBe(0);

    releaseEmbeddingPing();
    const results = await Promise.all([firstRecovery, secondRecovery]);
    expect(results.map((probe) => probe?.provider.id)).toEqual(["mock", "mock"]);
    expect(providerState.calls).toEqual([
      { provider: "openai", model: "mock-embed", fallback: "none" },
    ]);
    expect(providerState.embedQueryCalls).toBe(1);
    expect(providerState.embedBatchCalls).toBe(0);
    expect(manager.provider?.id).toBe("fallback-provider");
    expect(manager.fallbackFrom).toBe("mock");
    expect(manager.retireProvider).not.toHaveBeenCalled();
  });

  it("does not instantiate another fallback when the primary recovery probe fails", async () => {
    const manager = createRecoveryHarness();
    providerState.creationFailure = "openai";

    await expect(manager.attemptPrimaryProviderRecovery({})).resolves.toBeNull();

    expect(providerState.calls).toEqual([
      { provider: "openai", model: "mock-embed", fallback: "none" },
    ]);
    expect(manager.provider?.id).toBe("fallback-provider");
    expect(manager.fallbackFrom).toBe("mock");
    expect(manager.retireProvider).not.toHaveBeenCalled();
  });

  it("keeps a rejected recovery provider in managed retirement until cleanup finishes", async () => {
    const manager = createRecoveryHarness();
    let releaseProviderClose: () => void = () => {};
    providerState.providerCloseGate = new Promise<void>((resolve) => {
      releaseProviderClose = resolve;
    });
    providerState.embedQueryFailure = true;

    let retirementSettled = false;
    const retiredProviders: EmbeddingProvider[] = [];
    manager.retireProvider = async (provider: EmbeddingProvider) => {
      retiredProviders.push(provider);
      await provider.close?.();
      retirementSettled = true;
    };

    try {
      await expect(manager.attemptPrimaryProviderRecovery({})).resolves.toBeNull();

      const rejectedProvider = retiredProviders[0];
      expect(rejectedProvider).toBeDefined();
      expect(providerState.providerCloseCalls).toBe(1);
      expect(retirementSettled).toBe(false);
      expect(manager.provider?.id).toBe("fallback-provider");

      releaseProviderClose();
      await vi.waitFor(() => expect(retirementSettled).toBe(true));
    } finally {
      releaseProviderClose();
    }
  });

  it("lets the initiating caller abort only its wait for shared primary recovery", async () => {
    const manager = createRecoveryHarness();
    let releaseEmbeddingPing: () => void = () => {};
    providerState.embedQueryGate = new Promise<void>((resolve) => {
      releaseEmbeddingPing = resolve;
    });
    const controller = new AbortController();

    const firstRecovery = manager.attemptPrimaryProviderRecovery({ signal: controller.signal });
    await vi.waitFor(() => expect(providerState.embedQueryCalls).toBe(1));
    const secondRecovery = manager.attemptPrimaryProviderRecovery({});
    controller.abort(new Error("search deadline exceeded"));

    await expect(firstRecovery).rejects.toThrow("search deadline exceeded");
    expect(providerState.calls).toEqual([
      { provider: "openai", model: "mock-embed", fallback: "none" },
    ]);
    expect(providerState.embedQueryCalls).toBe(1);
    expect(providerState.embedBatchCalls).toBe(0);

    releaseEmbeddingPing();
    await expect(secondRecovery).resolves.toEqual(expect.objectContaining({}));
    expect(manager.provider?.id).toBe("fallback-provider");
    expect(manager.fallbackFrom).toBe("mock");
    expect(manager.retireProvider).not.toHaveBeenCalled();
  });

  it("keeps caller-aborted recovery manager-owned until the recovery probe finishes", async () => {
    const manager = createRecoveryHarness();
    let releaseEmbeddingPing: () => void = () => {};
    providerState.embedQueryGate = new Promise<void>((resolve) => {
      releaseEmbeddingPing = resolve;
    });
    const controller = new AbortController();

    const recovery = manager.attemptPrimaryProviderRecovery({ signal: controller.signal });
    await vi.waitFor(() => expect(providerState.embedQueryCalls).toBe(1));
    expect(manager.activeManagerOperations).toBe(1);

    let idleSettled = false;
    const idle = manager.awaitManagerIdle().then(() => {
      idleSettled = true;
    });
    await Promise.resolve();
    expect(idleSettled).toBe(false);

    controller.abort(new Error("search deadline exceeded"));
    await expect(recovery).rejects.toThrow("search deadline exceeded");
    await Promise.resolve();
    expect(manager.activeManagerOperations).toBe(1);
    expect(idleSettled).toBe(false);

    releaseEmbeddingPing();
    await idle;
    expect(idleSettled).toBe(true);
    expect(manager.activeManagerOperations).toBe(0);
    expect(manager.provider?.id).toBe("fallback-provider");
    expect(manager.fallbackFrom).toBe("mock");
    expect(manager.retireProvider).not.toHaveBeenCalled();
  });
});
