import { describe, expect, it, vi } from "vitest";
import * as support from "./service.test-support.js";
import type { WorkerTunnelManager } from "./tunnel.js";

type WorkerEnvironmentServiceError = support.WorkerEnvironmentServiceError;
type WorkerLifecycleLease = support.WorkerLifecycleLease;

describe("worker environment service", () => {
  support.setupWorkerEnvironmentServiceSuite();

  it("maintains configured providers on the existing timer with no environments", async () => {
    vi.useFakeTimers();
    const maintain = vi.fn(async () => {});
    const workerService = support.createService(support.createProvider(), {
      maintainProviders: maintain,
    });

    expect(support.testState.store.list()).toEqual([]);
    workerService.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(maintain).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(25);
    expect(maintain).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(1);
    await workerService.stop();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps maintenance off reconciliation and allocation while shutdown aborts and drains it", async () => {
    let finish!: () => void;
    const pending = new Promise<void>((resolve) => {
      finish = resolve;
    });
    const maintainProviders = vi.fn(async (_signal: AbortSignal) => pending);
    const workerService = support.createService(support.createProvider(), { maintainProviders });
    let stopped = false;
    let stopping: Promise<void> | undefined;
    try {
      await workerService.reconcileOnce();
      await workerService.reconcileOnce();
      expect(maintainProviders).toHaveBeenCalledOnce();
      await expect(
        workerService.create("development", "during-maintenance"),
      ).resolves.toMatchObject({ state: "ready" });
      stopping = workerService.stop().then(() => {
        stopped = true;
      });
      expect(maintainProviders.mock.calls[0]![0].aborted).toBe(true);
      await Promise.resolve();
      expect(stopped).toBe(false);
    } finally {
      finish();
      await stopping;
    }
    expect(stopped).toBe(true);
    await workerService.reconcileOnce();
    expect(maintainProviders).toHaveBeenCalledOnce();
  });

  it("reports failed maintenance and retries on the next sweep", async () => {
    const warn = vi.fn();
    const maintainProviders = vi.fn(async () => {
      throw new Error("fixture maintenance failure");
    });
    const workerService = support.createService(support.createProvider(), {
      maintainProviders,
      logger: { warn },
    });
    await workerService.reconcileOnce();
    await support.waitForFast(() => expect(warn).toHaveBeenCalledOnce());
    await workerService.reconcileOnce();
    await support.waitForFast(() => expect(maintainProviders).toHaveBeenCalledTimes(2));
    expect(warn).toHaveBeenCalledWith(
      "Worker provider maintenance sweep failed; cleanup will retry",
    );
  });

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

  it.each(["SQLITE_BUSY", "SQLITE_LOCKED"])(
    "continues reconciliation when terminal cleanup fails with %s",
    async (code) => {
      const prune = vi
        .spyOn(support.testState.store, "pruneTerminalEnvironments")
        .mockImplementation(() => {
          throw Object.assign(new Error("database is locked"), { code });
        });

      await expect(
        support.createService(support.createProvider()).reconcileOnce(),
      ).resolves.toBeUndefined();
      expect(prune).toHaveBeenCalledOnce();
    },
  );

  it("propagates non-lock terminal cleanup failures", async () => {
    const error = Object.assign(new Error("disk I/O error"), { code: "SQLITE_IOERR" });
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
    const environmentId = "worker-guarded-reconcile";
    support.seedReady(environmentId);
    const inspect = vi.fn(async () => ({ status: "active" as const }));
    const liveEvents = support.createLiveEvents();
    const unsubscribeTurnClaimClosed = vi.fn();
    const placementStore = {
      readWorkerTurnClaim: vi.fn(),
      readWorkerTurnLiveAckCursor: vi.fn(() => 0),
      validateWorkerTurn: vi.fn(() => false),
      isWorkerTurnToolAuthorized: vi.fn(() => false),
      updateAckCursors: vi.fn(),
      prepareWorkspaceResultOwnerRevocation: vi.fn(),
      registerTurnClaimClosedHandler: vi.fn(() => unsubscribeTurnClaimClosed),
    };
    const workerService = support.createService(support.createProvider({ inspect }), {
      liveEvents,
      placementStore,
    });
    const guardedEnvironmentIds: string[] = [];
    const uninstallGuard = workerService.installReconcileEnvironmentGuard(
      async (guardedEnvironmentId, reconcileCore) => {
        guardedEnvironmentIds.push(guardedEnvironmentId);
        await reconcileCore();
      },
    );

    expect(placementStore.registerTurnClaimClosedHandler).toHaveBeenCalledOnce();
    await workerService.reconcileEnvironment(environmentId);
    workerService.start();
    workerService.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(liveEvents.start).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(1);
    await vi.advanceTimersByTimeAsync(25);
    expect(guardedEnvironmentIds).toEqual([environmentId, environmentId, environmentId]);
    expect(inspect).toHaveBeenCalledTimes(3);
    await uninstallGuard();
    await workerService.reconcileEnvironment(environmentId);
    expect(guardedEnvironmentIds).toHaveLength(3);
    expect(inspect).toHaveBeenCalledTimes(4);
    await workerService.stop();

    expect(liveEvents.clear).toHaveBeenCalledTimes(2);
    expect(unsubscribeTurnClaimClosed).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("closes new guarded reconciliation and drains the admitted operation on uninstall", async () => {
    const environmentId = "worker-guard-uninstall";
    support.seedReady(environmentId);
    const inspect = vi.fn(async () => ({ status: "active" as const }));
    const workerService = support.createService(support.createProvider({ inspect }));
    let releaseGuard: (() => void) | undefined;
    const guardPending = new Promise<void>((resolve) => {
      releaseGuard = resolve;
    });
    let signalGuardStarted: (() => void) | undefined;
    const guardStarted = new Promise<void>((resolve) => {
      signalGuardStarted = resolve;
    });
    const uninstallGuard = workerService.installReconcileEnvironmentGuard(
      async (_guardedEnvironmentId, reconcileCore) => {
        signalGuardStarted?.();
        await guardPending;
        await reconcileCore();
      },
    );
    const reconciliation = workerService.reconcileEnvironment(environmentId);
    await guardStarted;
    let uninstalled = false;
    const uninstalling = uninstallGuard().then(() => {
      uninstalled = true;
    });
    await workerService.reconcileEnvironment(environmentId);
    await Promise.resolve();
    expect(uninstalled).toBe(false);
    expect(inspect).not.toHaveBeenCalled();

    releaseGuard?.();
    await Promise.all([reconciliation, uninstalling]);
    expect(inspect).toHaveBeenCalledOnce();
    await workerService.reconcileEnvironment(environmentId);
    expect(inspect).toHaveBeenCalledTimes(2);
  });

  it("closes guarded reconciliation admission and drains admitted recovery during stop", async () => {
    const environmentId = "worker-guard-stop";
    support.seedReady(environmentId);
    const inspect = vi.fn(async () => ({ status: "active" as const }));
    const workerService = support.createService(support.createProvider({ inspect }));
    let releaseGuard: (() => void) | undefined;
    const guardPending = new Promise<void>((resolve) => {
      releaseGuard = resolve;
    });
    let signalGuardStarted: (() => void) | undefined;
    const guardStarted = new Promise<void>((resolve) => {
      signalGuardStarted = resolve;
    });
    let guardCompleted = false;
    const uninstallGuard = workerService.installReconcileEnvironmentGuard(
      async (_guardedEnvironmentId, reconcileCore) => {
        signalGuardStarted?.();
        await guardPending;
        await reconcileCore();
        guardCompleted = true;
      },
    );
    const admitted = workerService.reconcileEnvironment(environmentId);
    await guardStarted;

    let stopped = false;
    const stopping = workerService.stop().then(() => {
      stopped = true;
    });
    await workerService.reconcileEnvironment(environmentId);
    await Promise.resolve();
    expect(stopped).toBe(false);
    expect(guardCompleted).toBe(false);
    expect(inspect).not.toHaveBeenCalled();

    releaseGuard?.();
    await Promise.all([admitted, stopping]);
    await uninstallGuard();
    expect(guardCompleted).toBe(true);
    expect(inspect).not.toHaveBeenCalled();
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
