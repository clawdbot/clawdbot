import { describe, expect, it, vi } from "vitest";
import * as support from "./service.test-support.js";
import type { WorkerTunnelManager } from "./tunnel.js";

type WorkerEnvironmentServiceError = support.WorkerEnvironmentServiceError;
type WorkerLifecycleLease = support.WorkerLifecycleLease;

describe("worker environment service", () => {
  support.setupWorkerEnvironmentServiceSuite();

  it("reconciles unrelated leases concurrently", async () => {
    support.seedReady("worker-concurrent-a");
    support.seedReady("worker-concurrent-b");
    let release: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const inspected: WorkerLifecycleLease[] = [];
    const provider = support.createProvider({
      inspect: async (lease) => {
        inspected.push(lease);
        await blocked;
        return { status: "active" };
      },
    });

    const reconciliation = support.createService(provider).reconcileOnce();
    try {
      await support.waitForFast(() => expect(inspected).toHaveLength(2));
    } finally {
      release?.();
    }
    await reconciliation;

    expect(new Set(inspected.map(({ leaseId }) => leaseId))).toEqual(
      new Set(["lease:worker-concurrent-a", "lease:worker-concurrent-b"]),
    );
  });

  it("prunes terminal environments after provider reconciliation", async () => {
    const prune = vi.spyOn(support.testState.store, "pruneTerminalEnvironments");

    await support.createService(support.createProvider()).reconcileOnce();

    expect(prune).toHaveBeenCalledOnce();
  });

  it("does not abort startup reconciliation when terminal cleanup is temporarily unavailable", async () => {
    const prune = vi
      .spyOn(support.testState.store, "pruneTerminalEnvironments")
      .mockImplementation(() => {
        throw Object.assign(new Error("SQLite transaction lock wait failed"), {
          code: "SQLITE_BUSY",
        });
      });

    await expect(
      support.createService(support.createProvider()).reconcileOnce(),
    ).resolves.toBeUndefined();
    expect(prune).toHaveBeenCalledOnce();
  });

  it.each([
    ["schema", new Error("no such table: worker_environments")],
    ["I/O", Object.assign(new Error("disk I/O error"), { code: "SQLITE_IOERR" })],
    [
      "corruption",
      Object.assign(new Error("database disk image is malformed"), {
        code: "SQLITE_CORRUPT",
        errcode: 11,
      }),
    ],
  ])("propagates terminal cleanup %s failures", async (_kind, error) => {
    const prune = vi
      .spyOn(support.testState.store, "pruneTerminalEnvironments")
      .mockImplementation(() => {
        throw error;
      });

    await expect(support.createService(support.createProvider()).reconcileOnce()).rejects.toBe(
      error,
    );
    expect(prune).toHaveBeenCalledOnce();
  });

  it("waits for timed-out provider work during shutdown", async () => {
    let finishProvision: (() => void) | undefined;
    const provisionPending = new Promise<void>((resolve) => {
      finishProvision = resolve;
    });
    const provision = vi.fn(async () => {
      await provisionPending;
      return { leaseId: "lease-stop-timeout", ssh: support.SSH_ENDPOINT };
    });
    const stopAll = vi.fn(async () => {});
    const tunnelManager = {
      stopAll,
    } as unknown as WorkerTunnelManager;
    const workerService = support.createService(support.createProvider({ provision }), {
      providerCallTimeoutMs: 5,
      tunnelManager,
    });
    const creation = workerService.create("development", "request-stop-provider-timeout");
    const creationResult = expect(creation).rejects.toMatchObject({
      code: "provider_failure",
    } satisfies Partial<WorkerEnvironmentServiceError>);
    let stopped = false;
    let stopping: Promise<void> | undefined;

    try {
      await support.waitForFast(() => expect(provision).toHaveBeenCalledOnce());
      await creationResult;
      stopping = workerService.stop().then(() => {
        stopped = true;
      });
      await support.waitForFast(() => expect(stopAll).toHaveBeenCalledOnce());
      await Promise.resolve();
      expect(stopped).toBe(false);
    } finally {
      finishProvision?.();
    }

    await stopping;
    expect(stopped).toBe(true);
  });

  it("owns and clears one periodic reconciliation timer", async () => {
    vi.useFakeTimers();
    const liveEvents = support.createLiveEvents();
    const workerService = support.createService(support.createProvider(), { liveEvents });

    workerService.start();
    workerService.start();
    expect(liveEvents.start).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(1);
    await workerService.stop();

    expect(liveEvents.clear).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects a create queued before service shutdown once its lock is acquired", async () => {
    let finishBootstrap: (() => void) | undefined;
    const bootstrapPending = new Promise<void>((resolve) => {
      finishBootstrap = resolve;
    });
    support.testState.bootstrapWorker = vi.fn(async () => {
      await bootstrapPending;
      return support.BOOTSTRAP_RECEIPT;
    });
    const provision = vi.fn(support.createProvider().provision);
    const workerService = support.createService(support.createProvider({ provision }));
    const first = workerService.create("development", "request-queued-before-stop");
    await support.waitForFast(() =>
      expect(support.testState.bootstrapWorker).toHaveBeenCalledTimes(1),
    );
    const queued = workerService.create("development", "request-queued-before-stop");
    const queuedResult = expect(queued).rejects.toMatchObject({
      code: "invalid_state",
    } satisfies Partial<WorkerEnvironmentServiceError>);

    const stopping = workerService.stop();
    finishBootstrap?.();

    await expect(first).resolves.toMatchObject({ state: "ready" });
    await queuedResult;
    await stopping;
    expect(provision).toHaveBeenCalledTimes(1);
  });

  it("drains a destroy accepted before service shutdown while it waits for the lock", async () => {
    let finishBootstrap: (() => void) | undefined;
    const bootstrapPending = new Promise<void>((resolve) => {
      finishBootstrap = resolve;
    });
    support.testState.bootstrapWorker = vi.fn(async () => {
      await bootstrapPending;
      return support.BOOTSTRAP_RECEIPT;
    });
    const destroy = vi.fn(async () => {});
    const workerService = support.createService(support.createProvider({ destroy }));
    const creation = workerService.create("development", "request-destroy-before-stop");
    await support.waitForFast(() =>
      expect(support.testState.bootstrapWorker).toHaveBeenCalledTimes(1),
    );
    const environmentId = support.testState.store.list()[0]?.environmentId;
    expect(environmentId).toBeTruthy();
    const teardown = workerService.destroy(environmentId!);
    const teardownResult = expect(teardown).resolves.toMatchObject({ state: "destroyed" });

    const stopping = workerService.stop();
    finishBootstrap?.();

    await expect(creation).resolves.toMatchObject({ state: "ready" });
    await teardownResult;
    await stopping;
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it("drains accepted operations after reconciliation rejects during shutdown", async () => {
    const durableStore = support.testState.store;
    support.testState.store = {
      ...support.testState.store,
      listForReconcile() {
        throw new Error("reconcile database read failed");
      },
    };
    let finishBootstrap: (() => void) | undefined;
    const bootstrapPending = new Promise<void>((resolve) => {
      finishBootstrap = resolve;
    });
    support.testState.bootstrapWorker = vi.fn(async () => {
      await bootstrapPending;
      return support.BOOTSTRAP_RECEIPT;
    });
    const workerService = support.createService(support.createProvider());
    const creation = workerService.create("development", "request-stop-after-reconcile-failure");
    await support.waitForFast(() =>
      expect(support.testState.bootstrapWorker).toHaveBeenCalledTimes(1),
    );
    const reconciliation = workerService.reconcileOnce();
    const reconciliationResult = expect(reconciliation).rejects.toThrow(
      "reconcile database read failed",
    );
    let stopped = false;
    const stopping = workerService.stop().then(() => {
      stopped = true;
    });

    await reconciliationResult;
    await Promise.resolve();
    expect(stopped).toBe(false);
    finishBootstrap?.();

    await expect(creation).resolves.toMatchObject({ state: "ready" });
    await stopping;
    expect(stopped).toBe(true);
    expect(durableStore.list()).toHaveLength(1);
  });

  it("starts without blocking gateway startup and drains reconciliation on stop", async () => {
    support.seedReady("worker-slow-inspection");
    let finishInspection: (() => void) | undefined;
    const inspectionPending = new Promise<void>((resolve) => {
      finishInspection = resolve;
    });
    const inspect = vi.fn(async () => {
      await inspectionPending;
      return { status: "active" as const };
    });
    const workerService = support.createService(support.createProvider({ inspect }));

    workerService.start();
    await support.waitForFast(() => expect(inspect).toHaveBeenCalledTimes(1));
    let stopped = false;
    const stopping = workerService.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);

    finishInspection?.();
    await stopping;
    expect(stopped).toBe(true);
    await expect(workerService.create("development", "request-after-stop")).rejects.toMatchObject({
      code: "invalid_state",
    } satisfies Partial<WorkerEnvironmentServiceError>);
    await expect(workerService.destroy("worker-slow-inspection")).rejects.toMatchObject({
      code: "invalid_state",
    } satisfies Partial<WorkerEnvironmentServiceError>);
  });
});
