// Memory Core tests cover primary provider recovery after fallback activation.
import type {
  OpenClawConfig,
  ResolvedMemorySearchConfig,
} from "openclaw/plugin-sdk/memory-core-host-engine-foundation";
import { beforeEach, describe, expect, it, vi } from "vitest";
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
  closing: boolean;
  closed: boolean;
  fallbackFrom?: string;
  lastPrimaryRecoveryAttemptMs: number;
  provider: EmbeddingProvider | null;
  providerRuntime?: unknown;
  providerKey: string;
  batch: unknown;
  attemptPrimaryProviderRecovery: (params: {
    force?: boolean;
    signal?: AbortSignal;
  }) => Promise<boolean>;
  computeProviderKey: () => string;
  resolveBatchConfig: () => unknown;
  retireProvider: (provider: EmbeddingProvider) => Promise<void>;
  awaitManagerIdle: () => Promise<void>;
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

function createRecoveryHarness(): RecoveryHarness {
  const fallbackProvider = createProvider("fallback-provider");
  const manager = Object.assign(Object.create(MemoryIndexManager.prototype), {
    cfg: {} as OpenClawConfig,
    agentId: "main",
    settings: createSettings(),
    acquireLocalService: undefined,
    activeManagerOperations: 0,
    managerIdleWaiters: new Set<() => void>(),
    closing: false,
    closed: false,
    fallbackFrom: "mock",
    fallbackReason: "primary provider failed",
    lastPrimaryRecoveryAttemptMs: 0,
    provider: fallbackProvider,
    providerRuntime: undefined,
    providerKey: "fallback-provider-key",
    batch: {},
    cacheKey: "test-cache-key",
    computeProviderKey: vi.fn(() => "mock-provider-key"),
    resolveBatchConfig: vi.fn(() => ({ enabled: false })),
    retireProvider: vi.fn(async () => {}),
  }) as RecoveryHarness;
  return manager;
}

describe("memory manager primary provider recovery", () => {
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

  it("restores the configured primary provider and retires the fallback provider", async () => {
    const manager = createRecoveryHarness();
    const fallbackProvider = manager.provider;

    await expect(manager.attemptPrimaryProviderRecovery({})).resolves.toBe(true);

    expect(providerState.calls).toEqual([
      { provider: "openai", model: "mock-embed", fallback: "none" },
    ]);
    expect(providerState.embedQueryCalls).toBe(1);
    expect(providerState.embedBatchCalls).toBe(0);
    expect(manager.provider?.id).toBe("mock");
    expect(manager.fallbackFrom).toBeUndefined();
    expect(manager.providerKey).toBe("mock-provider-key");
    expect(manager.retireProvider).toHaveBeenCalledWith(fallbackProvider);
  });

  it("serializes overlapping primary recovery probes", async () => {
    const manager = createRecoveryHarness();
    const fallbackProvider = manager.provider;
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
    await expect(Promise.all([firstRecovery, secondRecovery])).resolves.toEqual([true, true]);
    expect(providerState.calls).toEqual([
      { provider: "openai", model: "mock-embed", fallback: "none" },
    ]);
    expect(providerState.embedQueryCalls).toBe(1);
    expect(providerState.embedBatchCalls).toBe(0);
    expect(manager.provider?.id).toBe("mock");
    expect(manager.fallbackFrom).toBeUndefined();
    expect(manager.retireProvider).toHaveBeenCalledTimes(1);
    expect(manager.retireProvider).toHaveBeenCalledWith(fallbackProvider);
  });

  it("does not instantiate another fallback when the primary recovery probe fails", async () => {
    const manager = createRecoveryHarness();
    providerState.creationFailure = "openai";

    await expect(manager.attemptPrimaryProviderRecovery({})).resolves.toBe(false);

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
      await expect(manager.attemptPrimaryProviderRecovery({})).resolves.toBe(false);

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
    const fallbackProvider = manager.provider;
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
    await expect(secondRecovery).resolves.toBe(true);
    expect(manager.provider?.id).toBe("mock");
    expect(manager.fallbackFrom).toBeUndefined();
    expect(manager.retireProvider).toHaveBeenCalledTimes(1);
    expect(manager.retireProvider).toHaveBeenCalledWith(fallbackProvider);
  });

  it("keeps caller-aborted recovery manager-owned until the recovery probe finishes", async () => {
    const manager = createRecoveryHarness();
    const fallbackProvider = manager.provider;
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
    expect(manager.provider?.id).toBe("mock");
    expect(manager.fallbackFrom).toBeUndefined();
    expect(manager.retireProvider).toHaveBeenCalledTimes(1);
    expect(manager.retireProvider).toHaveBeenCalledWith(fallbackProvider);
  });
});
