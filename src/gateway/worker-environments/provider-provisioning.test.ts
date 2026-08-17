import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { describe, expect, it, vi } from "vitest";
import { WorkerProviderError, type WorkerProfile } from "../../plugins/types.js";
import type { GatewaySessionRow } from "../session-utils.types.js";
import { writeSessionStore } from "../test-helpers.js";
import { directSessionReq } from "../test/server-sessions.test-helpers.js";
import { admitWorkerConnection } from "./admission.js";
import { hashWorkerCredential } from "./credential.js";
import { REQUEST, seedActivePlacement } from "./placement-dispatch-test-fixtures.js";
import { createWorkerPlacementDispatchService } from "./placement-dispatch.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import { createWorkerSessionPlacementGate } from "./placement-worker-gate.js";
import * as support from "./service.test-support.js";
import { createWorkerWorkspaceOperationCoordinator } from "./workspace-operation-coordinator.js";

type WorkerEnvironmentServiceError = support.WorkerEnvironmentServiceError;

describe("worker environment service", () => {
  support.setupWorkerEnvironmentServiceSuite();

  it("persists intent and an immutable profile snapshot before provisioning", async () => {
    const operationIds: string[] = [];
    const provider = support.createProvider({
      provision: async (profile, operationId, options) => {
        operationIds.push(operationId);
        expect(support.testState.store.list()[0]).toMatchObject({
          state: "provisioning",
          provisionOperationId: operationId,
          profileSnapshot: {
            install: "bundle",
            machineClass: "beast",
            settings: { region: "test" },
          },
        });
        support.getDevelopmentProfile().settings = { region: "mutated" };
        expect(profile).toEqual({ region: "test" });
        expect(options).toEqual({ machineClass: "beast" });
        return { leaseId: "lease-1", ssh: support.SSH_ENDPOINT };
      },
    });

    const workerService = support.createService(provider);
    const result = await workerService.create("development", "request-1", "beast");
    const repeated = await workerService.create("development", "request-1", "beast");

    expect(result).toMatchObject({ state: "ready", leaseId: "lease-1", ownerEpoch: 1 });
    expect(repeated.environmentId).toBe(result.environmentId);
    expect(operationIds).toHaveLength(1);
    expect(operationIds[0]).toMatch(/^provision:v2:[a-f0-9]{64}$/u);
    expect(result.profileSnapshot).toMatchObject({ settings: { region: "test" } });
    expect(support.testState.store.getCredential(result.environmentId)).toMatchObject({
      credentialHash: hashWorkerCredential(support.CREDENTIAL),
      ownerEpoch: 1,
      sessionId: null,
    });
    const persistedCredential = support.testState.stateDb.db
      .prepare("SELECT * FROM worker_environment_credentials WHERE environment_id = ?")
      .get(result.environmentId);
    expect(persistedCredential).toMatchObject({
      credential_hash: hashWorkerCredential(support.CREDENTIAL),
    });
    expect(JSON.stringify(persistedCredential)).not.toContain(support.CREDENTIAL);
    const binding = { environmentId: result.environmentId, ownerEpoch: 1, sessionId: null };
    const grant = workerService.takeMintedCredential(binding);
    expect(grant).toMatchObject({
      credential: support.CREDENTIAL,
      ownerEpoch: 1,
      sessionId: null,
    });
    expect(workerService.acknowledgeCredentialDelivery(grant!)).toBe(true);
    expect(support.testState.store.getCredential(result.environmentId)).toMatchObject({
      deliveredAtMs: support.testState.nowMs,
    });
    expect(workerService.takeMintedCredential(binding)).toBeUndefined();
    await expect(workerService.create("development", "request-1", "fast")).rejects.toMatchObject({
      code: "invalid_profile",
    });
  });

  it("delegates configured machine options to the profile provider", async () => {
    const listMachineOptions = vi.fn(() => [{ id: "standard", label: "Standard", default: true }]);
    const workerService = support.createService(support.createProvider({ listMachineOptions }));

    await expect(workerService.listMachineOptions("development")).resolves.toEqual([
      { id: "standard", label: "Standard", default: true },
    ]);
    expect(listMachineOptions).toHaveBeenCalledWith({ region: "test" });
  });

  it.each([
    [
      "duplicate ids",
      [
        { id: "fast", label: "Fast" },
        { id: "fast", label: "Faster" },
      ],
    ],
    ["blank ids", [{ id: " ", label: "Fast" }]],
    ["malformed labels", [{ id: "fast", label: 16 }]],
    [
      "multiple defaults",
      [
        { id: "standard", label: "Standard", default: true },
        { id: "fast", label: "Fast", default: true },
      ],
    ],
    [
      "over-limit catalogs",
      Array.from({ length: 33 }, (_, index) => ({ id: `machine-${index}`, label: "Machine" })),
    ],
  ])("omits %s returned by a worker provider", async (_name, options) => {
    const provider = support.createProvider();
    Object.defineProperty(provider, "listMachineOptions", { value: () => options });
    const workerService = support.createService(provider);

    await expect(workerService.listMachineOptions("development")).resolves.toBeUndefined();
  });

  it("commits an installed Gateway bundle receipt and credential for a node lease", async () => {
    const workerBuild = structuredClone(support.BOOTSTRAP_RECEIPT);
    const placements = createWorkerSessionPlacementStore({
      database: support.testState.stateDb,
      now: () => support.testState.nowMs,
    });
    const placementGate = createWorkerSessionPlacementGate(placements);
    const workerService = support.createService(
      support.createProvider({
        provisionBeforeInstallation: true,
        provision: async () => ({
          leaseId: "device-lease-1",
          node: { deviceId: "device-1" },
          sharedHost: true,
        }),
      }),
      { ensureNodeWorkerBundle: async () => workerBuild, placementStore: placementGate },
    );

    const result = await workerService.create("development", "request-device");

    expect(result).toMatchObject({
      state: "ready",
      leaseId: "device-lease-1",
      sshEndpoint: null,
      bootstrapReceipt: { ...workerBuild, installKind: "bundle" },
      sharedHost: true,
      ownerEpoch: 1,
    });
    expect(support.testState.prepareInstallation).not.toHaveBeenCalled();
    expect(support.testState.bootstrapWorker).not.toHaveBeenCalled();
    const credential = workerService.takeMintedCredential({
      environmentId: result.environmentId,
      ownerEpoch: result.ownerEpoch,
      sessionId: null,
    });
    expect(credential).toMatchObject({
      credential: support.CREDENTIAL,
      bundleHash: support.BUNDLE_HASH,
    });
    await workerService.attachSession({
      environmentId: result.environmentId,
      ownerEpoch: result.ownerEpoch,
      sessionId: REQUEST.sessionId,
    });
    const attached = support.testState.store.get(result.environmentId)!;
    seedActivePlacement(placements, {
      environmentId: result.environmentId,
      ownerEpoch: attached.ownerEpoch,
    });
    const turnClaim = placements.claimTurn({
      sessionId: REQUEST.sessionId,
      sessionKey: REQUEST.sessionKey,
      agentId: REQUEST.agentId,
      claimId: "claim-device",
      runId: "run-device",
      owner: {
        kind: "worker",
        environmentId: result.environmentId,
        ownerEpoch: attached.ownerEpoch,
      },
    });
    const turnCredential = await workerService.acquireTurnCredential(turnClaim);
    const admission = {
      environmentId: result.environmentId,
      credential: turnCredential.credential,
      ownerEpoch: attached.ownerEpoch,
      rpcSetVersion: 1,
      sessionId: REQUEST.sessionId,
      runId: turnClaim.runId,
      handshake: workerBuild,
    } as const;
    expect(
      admitWorkerConnection({
        store: support.testState.store,
        admission,
        expectedBuild: workerBuild,
        nowMs: support.testState.nowMs,
        turnClaim,
      }),
    ).toMatchObject({ ok: true });
    expect(
      admitWorkerConnection({
        store: support.testState.store,
        admission: {
          ...admission,
          handshake: { ...workerBuild, bundleHash: "d".repeat(64) },
        },
        expectedBuild: workerBuild,
        nowMs: support.testState.nowMs,
        turnClaim,
      }),
    ).toEqual({ ok: false, reason: "bundle-mismatch" });
  });

  it("fails node provisioning visibly when Gateway bundle installation fails", async () => {
    const workerService = support.createService(
      support.createProvider({
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

  it("creates a nested environment from its parent's snapshot after config drift", async () => {
    const provisionedProfiles: WorkerProfile[] = [];
    let lease = 0;
    let credential = 0;
    const workerService = support.createService(
      support.createProvider({
        provision: async (profile) => {
          provisionedProfiles.push(structuredClone(profile));
          lease += 1;
          return { leaseId: `lease-${lease}`, ssh: support.SSH_ENDPOINT };
        },
      }),
      {
        generateWorkerCredential: () => `nested-worker-credential-${(credential += 1)}`,
      },
    );
    const parent = await workerService.create("development", "parent-profile-snapshot");
    support.getDevelopmentProfile().settings = { region: "mutated" };

    const child = await workerService.createFromProfileSnapshot(
      {
        profileId: parent.profileId,
        providerId: parent.providerId,
        profileSnapshot: parent.profileSnapshot,
      },
      "child-profile-snapshot",
    );

    expect(provisionedProfiles).toEqual([{ region: "test" }, { region: "test" }]);
    expect(child).toMatchObject({
      profileId: parent.profileId,
      providerId: parent.providerId,
      profileSnapshot: parent.profileSnapshot,
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
      runReclaimBarrier: async ({ reclaim }) => await reclaim("/gateway/workspace"),
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
        executionMode: "worker-turn",
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

  it("rejects plaintext secret fields before persisting intent", async () => {
    support.getDevelopmentProfile().settings = {
      keyRef: "not-a-secret-ref",
    };
    const provision = vi.fn(support.createProvider().provision);

    await expect(
      support
        .createService(support.createProvider({ provision }))
        .create("development", "request-secret"),
    ).rejects.toMatchObject({ code: "invalid_profile" });
    expect(provision).not.toHaveBeenCalled();
    expect(support.testState.store.list()).toEqual([]);
  });

  it("records permanent provider profile rejection as terminal", async () => {
    let provisionCalls = 0;
    const provider = support.createProvider({
      provision: async () => {
        provisionCalls += 1;
        throw new WorkerProviderError("region is required");
      },
    });
    const workerService = support.createService(provider);

    await expect(workerService.create("development", "request-invalid")).rejects.toMatchObject({
      code: "invalid_profile",
      message: expect.stringContaining("region is required"),
    } satisfies Partial<WorkerEnvironmentServiceError>);
    const record = expectDefined(
      support.testState.store.list()[0],
      "store.list()[0] test invariant",
    );
    expect(record).toMatchObject({ state: "failed", lastError: "region is required" });

    await workerService.reconcileOnce();
    await expect(workerService.destroy(record.environmentId)).resolves.toMatchObject({
      state: "failed",
    });
    expect(provisionCalls).toBe(1);
  });

  it("rejects non-canonical profile ids before persistence", async () => {
    const workerService = support.createService(support.createProvider());

    await expect(workerService.create(" development ", "request-spaced")).rejects.toMatchObject({
      code: "invalid_profile",
    } satisfies Partial<WorkerEnvironmentServiceError>);
    expect(support.testState.store.list()).toEqual([]);
  });

  it.each(["direct destroy", "restart reconcile"] as const)(
    "cancels a requested intent without allocating on %s",
    async (mode) => {
      const intent = support.testState.store.createIntent({
        environmentId: `worker-cancel-${mode}`,
        providerId: "fake",
        profileId: "development",
        profileSnapshot: { settings: { region: "test" } },
        provisionOperationId: `provision:cancel-${mode}`,
      });
      const provision = vi.fn(support.createProvider().provision);
      const workerService = support.createService(support.createProvider({ provision }));

      if (mode === "direct destroy") {
        await workerService.destroy(intent.environmentId);
      } else {
        support.testState.store.requestDestroy({
          environmentId: intent.environmentId,
          state: "requested",
        });
        support.testState.providersEnabled = false;
        await workerService.reconcileOnce();
      }

      expect(provision).not.toHaveBeenCalled();
      expect(support.testState.store.get(intent.environmentId)).toMatchObject({
        state: "failed",
        lastError: "Provisioning canceled before provider allocation",
        destroyRequestedAtMs: expect.any(Number),
      });
    },
  );
});
