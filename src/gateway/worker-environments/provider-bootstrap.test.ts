import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import type { GatewaySessionRow } from "../session-utils.types.js";
import { writeSessionStore } from "../test-helpers.js";
import { directSessionReq } from "../test/server-sessions.test-helpers.js";
import { createWorkerPlacementDispatchService } from "./placement-dispatch.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import * as support from "./service.test-support.js";
import { createWorkerWorkspaceOperationCoordinator } from "./workspace-operation-coordinator.js";

type WorkerEnvironmentServiceError = support.WorkerEnvironmentServiceError;

describe("worker environment service", () => {
  support.setupWorkerEnvironmentServiceSuite();

  it("fails node provisioning visibly when Gateway bundle installation fails", async () => {
    const workerService = support.createService(
      support.createProvider({
        supportedExecutionModes: ["worker-turn"],
        provisionBeforeInstallation: true,
        provision: async () => ({
          leaseId: "device-lease-install-failure",
          node: { deviceId: "device-1" },
        }),
      }),
      {
        ensureNodeWorkerBundle: async () => {
          throw new Error("bundle transfer unavailable");
        },
      },
    );

    await expect(
      workerService.create("development", "request-device-install-failure"),
    ).rejects.toMatchObject({
      code: "bootstrap_failure",
      message: expect.stringContaining("bundle transfer unavailable"),
    } satisfies Partial<WorkerEnvironmentServiceError>);
    expect(support.testState.store.list()[0]).toMatchObject({
      state: "failed",
      lastError: expect.stringContaining("bundle transfer unavailable"),
    });
  });

  it("stays bootstrapping until the SSH install receipt is durable", async () => {
    let finishBootstrap: (() => void) | undefined;
    const bootstrapPending = new Promise<void>((resolve) => {
      finishBootstrap = resolve;
    });
    support.testState.bootstrapWorker = vi.fn(async () => {
      await bootstrapPending;
      return support.BOOTSTRAP_RECEIPT;
    });
    const creation = support
      .createService(support.createProvider())
      .create("development", "request-bootstrap");

    await support.waitForFast(() =>
      expect(support.testState.store.list()[0]).toMatchObject({
        state: "bootstrapping",
        bootstrapReceipt: null,
      }),
    );
    finishBootstrap?.();

    await expect(creation).resolves.toMatchObject({
      state: "ready",
      bootstrapReceipt: support.BOOTSTRAP_RECEIPT,
    });
  });

  it("records installation preparation failure before allocating a lease", async () => {
    support.testState.prepareInstallation = vi.fn(async () => {
      throw new Error("npm install requires a released gateway package");
    });
    const provision = vi.fn(support.createProvider().provision);
    const workerService = support.createService(support.createProvider({ provision }));

    await expect(
      workerService.create("development", "request-preparation-failure"),
    ).rejects.toMatchObject({
      code: "bootstrap_failure",
      message: expect.stringContaining("npm install requires a released gateway package"),
    } satisfies Partial<WorkerEnvironmentServiceError>);

    expect(provision).not.toHaveBeenCalled();
    expect(support.testState.store.list()[0]).toMatchObject({
      state: "failed",
      leaseId: null,
      lastError: "npm install requires a released gateway package",
    });
    expect(workerService.list()[0]).toMatchObject({
      state: "failed",
      error: "npm install requires a released gateway package",
    });
  });

  it("keeps a remotely bootstrapped lease retryable when receipt persistence fails", async () => {
    const durableStore = support.testState.store;
    let persistenceFails = true;
    support.testState.store = {
      ...support.testState.store,
      transition(input) {
        if (persistenceFails && input.from === "bootstrapping" && input.to === "ready") {
          persistenceFails = false;
          throw new Error("receipt database write failed");
        }
        return durableStore.transition(input);
      },
    };
    const destroy = vi.fn(async () => {});
    const workerService = support.createService(support.createProvider({ destroy }));

    await expect(
      workerService.create("development", "request-receipt-write-failure"),
    ).rejects.toThrow("receipt database write failed");
    expect(support.testState.store.list()[0]).toMatchObject({
      state: "bootstrapping",
      leaseId: "lease-1",
    });
    expect(destroy).not.toHaveBeenCalled();

    await workerService.reconcileOnce();
    expect(support.testState.store.list()[0]).toMatchObject({
      state: "ready",
      bootstrapReceipt: support.BOOTSTRAP_RECEIPT,
    });
    expect(support.testState.bootstrapWorker).toHaveBeenCalledTimes(2);
  });

  it("tears down the lease and records a bounded bootstrap failure", async () => {
    // Assembled at runtime so review-bundle secret scanners do not flag a key-shaped literal.
    const secret = [
      String.fromCharCode(115, 107),
      "proj",
      "bootstrap",
      "abcdefghijklmnopqrstuvwxyz",
    ].join("-");
    support.testState.bootstrapWorker = vi.fn(async () => {
      throw new Error(`remote bootstrap rejected ${secret}`);
    });
    const destroy = vi.fn(async () => {});
    const workerService = support.createService(support.createProvider({ destroy }));

    const creation = workerService.create("development", "request-bootstrap-failure");
    await expect(creation).rejects.toMatchObject({
      code: "bootstrap_failure",
      message: expect.stringContaining("Worker bootstrap failed: remote bootstrap rejected"),
    } satisfies Partial<WorkerEnvironmentServiceError>);
    await expect(creation).rejects.not.toThrow(secret);

    expect(destroy).toHaveBeenCalledTimes(1);
    expect(support.testState.store.list()[0]).toMatchObject({
      state: "failed",
      leaseId: null,
      sshEndpoint: null,
      bootstrapReceipt: null,
      lastError: expect.stringContaining("remote bootstrap rejected"),
    });
    expect(support.testState.store.list()[0]?.lastError).not.toContain(secret);
  });

  it("projects bounded bootstrap detail through sessions.describe after failed dispatch", async () => {
    // Assembled at runtime so review-bundle secret scanners do not flag a key-shaped literal.
    const secret = [
      String.fromCharCode(115, 107),
      "proj",
      "placement",
      "abcdefghijklmnopqrstuvwxyz",
    ].join("-");
    support.testState.bootstrapWorker = vi.fn(async () => {
      throw new Error(`remote bootstrap rejected ${secret} ${"failure ".repeat(200)}`);
    });
    const workerService = support.createService(support.createProvider());
    const placements = createWorkerSessionPlacementStore({
      database: support.testState.stateDb,
      now: () => support.testState.nowMs,
    });
    const dispatch = createWorkerPlacementDispatchService({
      placements,
      environments: workerService,
      workspaceOperations: createWorkerWorkspaceOperationCoordinator(),
      runLocalBarrier: async ({ startDispatch }) => startDispatch(),
      runActivationBarrier: async ({ activate }) => activate(),
      runMoveBarrier: async ({ begin }) => begin(),
      resolveMoveDestination: async () => undefined,
      runReclaimBarrier: async ({ begin, reclaim }) => await reclaim("/gateway/workspace", begin()),
      runFailedReclaimBarrier: async ({ reclaim }) => await reclaim(),
      resolveWorkspacePath: async () => "/gateway/workspace",
      reportWorkspaceResultConflict: async () => {},
      resolveWorkspaceResultConflict: async () => undefined,
    });

    await expect(
      dispatch.dispatch({
        sessionId: "session-bootstrap-failure",
        sessionKey: "agent:main:session-bootstrap-failure",
        agentId: "main",
        profileId: "development",
        executionMode: "remote-exec",
      }),
    ).rejects.toThrow("Worker bootstrap failed: remote bootstrap rejected");

    const persisted = expectDefined(
      placements.get("session-bootstrap-failure"),
      "failed worker placement",
    );
    const sessionStorePath = path.join(support.testState.root, "sessions.json");
    await writeSessionStore({
      entries: { main: { sessionId: persisted.sessionId, updatedAt: support.testState.nowMs } },
      storePath: sessionStorePath,
    });
    const described = await directSessionReq<{ session: GatewaySessionRow | null }>(
      "sessions.describe",
      { key: "main" },
      {
        context: {
          getRuntimeConfig: () => ({ session: { store: sessionStorePath } }),
          workerSessionPlacementService: placements,
        },
      },
    );
    const describedPlacement = described.payload?.session?.placement;
    expect(described).toMatchObject({ ok: true });
    expect(describedPlacement).toMatchObject({
      state: "failed",
      recoveryError: expect.stringContaining("remote bootstrap rejected"),
    });
    if (describedPlacement?.state !== "failed") {
      throw new Error("sessions.describe did not project the failed worker placement");
    }
    expect(describedPlacement.recoveryError).not.toContain(secret);
    expect(describedPlacement.recoveryError.length).toBeLessThanOrEqual(1_024);
  });

  it("keeps an indeterminate bootstrap teardown retryable", async () => {
    support.testState.bootstrapWorker = vi.fn(async () => {
      throw new Error("remote bootstrap failed");
    });
    let teardownFails = true;
    const workerService = support.createService(
      support.createProvider({
        destroy: async () => {
          if (teardownFails) {
            throw new Error("provider teardown timed out");
          }
        },
      }),
    );

    await expect(
      workerService.create("development", "request-bootstrap-cleanup"),
    ).rejects.toMatchObject({
      code: "bootstrap_failure",
      message: "Worker bootstrap failed; teardown is pending: remote bootstrap failed",
    } satisfies Partial<WorkerEnvironmentServiceError>);
    expect(support.testState.store.list()[0]).toMatchObject({
      state: "destroying",
      leaseId: "lease-1",
      destroyRequestedAtMs: expect.any(Number),
      teardownTerminalState: "failed",
      lastError: "remote bootstrap failed",
    });

    teardownFails = false;
    await workerService.reconcileOnce();
    expect(support.testState.store.list()[0]).toMatchObject({
      state: "failed",
      leaseId: null,
      sshEndpoint: null,
      lastError: expect.stringContaining("remote bootstrap failed"),
    });
  });

  it("bounds worker identity resolution as a provider operation", async () => {
    const events: string[] = [];
    let finishIdentity: (() => void) | undefined;
    const identityPending = new Promise<void>((resolve) => {
      finishIdentity = resolve;
    });
    support.testState.bootstrapWorker = vi.fn(async ({ installation, resolveIdentity, signal }) => {
      signal.addEventListener("abort", () => void events.push("abort"), { once: true });
      await resolveIdentity(support.SSH_ENDPOINT.keyRef);
      return {
        bundleHash: installation.bundleHash,
        openclawVersion: installation.openclawVersion,
        protocolFeatures: [...installation.protocolFeatures],
      };
    });
    const destroy = vi.fn(async () => {
      events.push("destroy");
    });
    const workerService = support.createService(support.createProvider({ destroy }), {
      providerCallTimeoutMs: 5,
      resolveSshIdentity: async () => {
        events.push("identity:start");
        await identityPending;
        events.push("identity:end");
        return { kind: "path", path: "/keys/worker" };
      },
    });

    const creation = workerService.create("development", "request-identity-timeout");
    const creationResult = expect(creation).rejects.toMatchObject({
      code: "bootstrap_failure",
    } satisfies Partial<WorkerEnvironmentServiceError>);
    try {
      await support.waitForFast(() =>
        expect(support.testState.store.list()[0]).toMatchObject({ state: "destroying" }),
      );
      expect(events).toEqual(["identity:start", "abort"]);
      expect(destroy).not.toHaveBeenCalled();
    } finally {
      finishIdentity?.();
    }

    await creationResult;
    expect(destroy).toHaveBeenCalledOnce();
    expect(events).toEqual(["identity:start", "abort", "identity:end", "destroy"]);
    expect(support.testState.store.list()[0]).toMatchObject({ state: "failed", leaseId: null });
  });

  it("aborts a timed-out SSH bootstrap before tearing down its lease", async () => {
    const events: string[] = [];
    support.testState.bootstrapWorker = vi.fn(
      async ({ signal }) =>
        await new Promise<never>((_resolve, reject) => {
          signal.addEventListener(
            "abort",
            () => {
              events.push("abort");
              reject(new Error("SSH bootstrap aborted"));
            },
            { once: true },
          );
        }),
    );
    const destroy = vi.fn(async () => {
      events.push("destroy");
    });
    const workerService = support.createService(support.createProvider({ destroy }), {
      bootstrapCallTimeoutMs: 10,
    });

    await expect(
      workerService.create("development", "request-bootstrap-timeout"),
    ).rejects.toMatchObject({
      code: "bootstrap_failure",
    } satisfies Partial<WorkerEnvironmentServiceError>);

    expect(events).toEqual(["abort", "destroy"]);
    expect(support.testState.store.list()[0]).toMatchObject({ state: "failed", leaseId: null });
  });

  it("allows a large bundle bootstrap to outlive the former service deadline", async () => {
    vi.useFakeTimers();
    support.testState.prepareInstallation = vi.fn(async () => ({
      ...support.BUNDLE_ARTIFACT,
      tarballBytes: 243_000_000,
    }));
    let finishBootstrap: (() => void) | undefined;
    const bootstrapPending = new Promise<void>((resolve) => {
      finishBootstrap = resolve;
    });
    let bootstrapSignal: AbortSignal | undefined;
    support.testState.bootstrapWorker = vi.fn(async ({ signal }) => {
      bootstrapSignal = signal;
      await bootstrapPending;
      return support.BOOTSTRAP_RECEIPT;
    });
    const workerService = support.createService(support.createProvider());

    const creation = workerService.create("development", "request-large-bundle-bootstrap");
    await support.waitForFast(() =>
      expect(support.testState.bootstrapWorker).toHaveBeenCalledOnce(),
    );
    let creationError: unknown;
    try {
      await vi.advanceTimersByTimeAsync(35 * 60_000 + 1);
      expect(bootstrapSignal?.aborted).toBe(false);
    } finally {
      finishBootstrap?.();
      await creation.catch((error: unknown) => {
        creationError = error;
      });
    }
    expect(creationError).toBeUndefined();
    expect(support.testState.store.list()[0]).toMatchObject({ state: "ready" });
  });
});
