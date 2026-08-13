import path from "node:path";
import { expectDefined } from "@openclaw/normalization-core";
import { MAX_TIMER_TIMEOUT_MS } from "@openclaw/normalization-core/number-coercion";
import { describe, expect, it, vi } from "vitest";
import { WorkerProviderError, type WorkerProfile } from "../../plugins/types.js";
import {
  closeOpenClawStateDatabaseForTest,
  openOpenClawStateDatabase,
} from "../../state/openclaw-state-db.js";
import { VERSION } from "../../version.js";
import type { GatewaySessionRow } from "../session-utils.types.js";
import { writeSessionStore } from "../test-helpers.js";
import { directSessionReq } from "../test/server-sessions.test-helpers.js";
import { admitWorkerConnection } from "./admission.js";
import { hashWorkerCredential } from "./credential.js";
import { createWorkerPlacementDispatchService } from "./placement-dispatch.js";
import { createWorkerSessionPlacementStore } from "./placement-store.js";
import * as support from "./service.test-support.js";
import { createWorkerEnvironmentStore } from "./store.js";
import { createWorkerWorkspaceOperationCoordinator } from "./workspace-operation-coordinator.js";

type WorkerEnvironmentServiceError = support.WorkerEnvironmentServiceError;

describe("worker environment service", () => {
  support.setupWorkerEnvironmentServiceSuite();

  it("persists intent and an immutable profile snapshot before provisioning", async () => {
    const operationIds: string[] = [];
    const provider = support.createProvider({
      provision: async (profile, operationId) => {
        operationIds.push(operationId);
        expect(support.testState.store.list()[0]).toMatchObject({
          state: "provisioning",
          provisionOperationId: operationId,
          profileSnapshot: {
            install: "bundle",
            settings: { region: "test" },
          },
        });
        support.getDevelopmentProfile().settings = { region: "mutated" };
        expect(profile).toEqual({ region: "test" });
        return { leaseId: "lease-1", ssh: support.SSH_ENDPOINT };
      },
    });

    const workerService = support.createService(provider);
    const result = await workerService.create("development", "request-1");
    const repeated = await workerService.create("development", "request-1");

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
  });

  it("commits a local-install receipt and credential for a node lease", async () => {
    const workerBuild = {
      bundleHash: "c".repeat(64),
      openclawVersion: VERSION,
      protocolFeatures: ["worker-heartbeat-v1"],
    };
    support.testState.prepareInstallation = vi.fn(async () => {
      throw new Error("node leases must not prepare an SSH installation");
    });
    const workerService = support.createService(
      support.createProvider({
        provisionBeforeInstallation: true,
        provision: async () => ({
          leaseId: "device-lease-1",
          node: { deviceId: "device-1" },
          sharedHost: true,
        }),
      }),
      { resolveNodeWorkerBuild: async () => workerBuild },
    );

    const result = await workerService.create("development", "request-device");

    expect(result).toMatchObject({
      state: "ready",
      leaseId: "device-lease-1",
      sshEndpoint: null,
      bootstrapReceipt: { ...workerBuild, installKind: "local" },
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
      bundleHash: "c".repeat(64),
    });
    const attachedCredential = await workerService.attachSession({
      environmentId: result.environmentId,
      ownerEpoch: result.ownerEpoch,
      sessionId: "session-device",
    });
    const attached = support.testState.store.get(result.environmentId)!;
    const admission = {
      environmentId: result.environmentId,
      credential: attachedCredential.credential,
      ownerEpoch: attached.ownerEpoch,
      rpcSetVersion: 1,
      sessionId: "session-device",
      runId: "run-device",
      handshake: workerBuild,
    } as const;
    expect(
      admitWorkerConnection({
        store: support.testState.store,
        admission,
        expectedBuild: workerBuild,
        nowMs: support.testState.nowMs,
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
      }),
    ).toEqual({ ok: false, reason: "bundle-mismatch" });
  });

  it("fails node provisioning visibly when the node version differs", async () => {
    const nodeVersion = "0.0.0-node";
    const workerService = support.createService(
      support.createProvider({
        provisionBeforeInstallation: true,
        provision: async () => ({
          leaseId: "device-lease-version-mismatch",
          node: { deviceId: "device-1" },
        }),
      }),
      {
        resolveNodeWorkerBuild: async () => ({
          bundleHash: "c".repeat(64),
          openclawVersion: nodeVersion,
          protocolFeatures: ["worker-heartbeat-v1"],
        }),
      },
    );

    await expect(
      workerService.create("development", "request-device-mismatch"),
    ).rejects.toMatchObject({
      code: "bootstrap_failure",
      message: expect.stringContaining(`OpenClaw ${nodeVersion}`),
    } satisfies Partial<WorkerEnvironmentServiceError>);
    expect(support.testState.store.list()[0]).toMatchObject({
      state: "failed",
      lastError: expect.stringContaining(`gateway runs ${VERSION}`),
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

  it("adopts one committed provision across a service and store restart", async () => {
    const physicalLeases = new Set<string>();
    const operationIds: string[] = [];
    const destroyed: string[] = [];
    let creates = 0;
    let loseFirstReply = true;
    const provider = () =>
      support.createProvider({
        provision: async (_profile, operationId) => {
          operationIds.push(operationId);
          if (!physicalLeases.has("lease-restarted")) {
            creates += 1;
            physicalLeases.add("lease-restarted");
          }
          if (loseFirstReply) {
            loseFirstReply = false;
            throw new Error("provider response was lost after commit");
          }
          return { leaseId: "lease-restarted", ssh: support.SSH_ENDPOINT };
        },
        destroy: async ({ leaseId }) => {
          destroyed.push(leaseId);
          physicalLeases.delete(leaseId);
        },
      });
    const first = support.createService(provider());

    await expect(first.create("development", "request-restart-replay")).rejects.toMatchObject({
      code: "provider_failure",
    } satisfies Partial<WorkerEnvironmentServiceError>);
    const environmentId = expectDefined(
      support.testState.store.list()[0],
      "persisted provision intent",
    ).environmentId;
    const operationId = expectDefined(
      support.testState.store.get(environmentId),
      "persisted provision record",
    ).provisionOperationId;
    expect(operationId).toMatch(/^provision:v2:[a-f0-9]{64}$/u);
    expect(support.testState.store.get(environmentId)).toMatchObject({
      state: "provisioning",
      leaseId: null,
    });

    await first.stop();
    support.testState.service = undefined;
    closeOpenClawStateDatabaseForTest();
    support.testState.stateDb = openOpenClawStateDatabase({
      env: { OPENCLAW_STATE_DIR: support.testState.root },
    });
    support.testState.store = createWorkerEnvironmentStore({
      database: support.testState.stateDb,
      now: () => support.testState.nowMs,
    });

    const restarted = support.createService(provider());
    restarted.start();
    await support.waitForFast(() =>
      expect(support.testState.store.get(environmentId)).toMatchObject({
        state: "ready",
        leaseId: "lease-restarted",
        lastError: null,
      }),
    );
    await restarted.destroy(environmentId);

    expect(creates).toBe(1);
    expect(operationIds).toEqual([operationId, operationId]);
    expect(destroyed).toEqual(["lease-restarted"]);
    expect(physicalLeases.size).toBe(0);
    expect(support.testState.store.get(environmentId)).toMatchObject({
      state: "destroyed",
      leaseId: "lease-restarted",
    });
  });

  it("records a permanent legacy provision replay failure without allocating", async () => {
    const legacyOperationId = `provision:${"0".repeat(64)}`;
    const intent = support.testState.store.createIntent({
      environmentId: "worker-legacy-provision",
      providerId: "fake",
      profileId: "development",
      profileSnapshot: { settings: { region: "test" } },
      provisionOperationId: legacyOperationId,
    });
    support.testState.store.transition({
      environmentId: intent.environmentId,
      from: intent.state,
      to: "provisioning",
    });
    const allocate = vi.fn(async () => ({ leaseId: "must-not-exist", ssh: support.SSH_ENDPOINT }));
    const provider = support.createProvider({
      provision: async (_profile, operationId) => {
        if (operationId === legacyOperationId) {
          throw new WorkerProviderError("Legacy Crabbox provision state cannot be replayed safely");
        }
        return await allocate();
      },
    });

    await support.createService(provider).reconcileOnce();

    expect(allocate).not.toHaveBeenCalled();
    expect(support.testState.store.get(intent.environmentId)).toMatchObject({
      state: "failed",
      leaseId: null,
      lastError: "Legacy Crabbox provision state cannot be replayed safely",
    });
  });

  it("does not resolve a provider provision timeout when the service override is set", async () => {
    const resolveProvisionTimeoutMs = vi.fn(() => {
      throw new Error("provider timeout hook must not run");
    });
    const workerService = support.createService(
      support.createProvider({ resolveProvisionTimeoutMs }),
      {
        providerCallTimeoutMs: 1_000,
      },
    );

    await expect(
      workerService.create("development", "request-provider-timeout-override"),
    ).resolves.toMatchObject({ state: "ready" });
    expect(resolveProvisionTimeoutMs).not.toHaveBeenCalled();
  });

  it.each([
    ["zero", 0],
    ["negative", -1],
    ["fractional", 1.5],
    ["non-finite", Number.NaN],
    ["timer overflow", MAX_TIMER_TIMEOUT_MS + 1],
  ])("rejects a %s provider provision timeout before allocation", async (_label, timeoutMs) => {
    const provision = vi.fn(async () => ({
      leaseId: "lease-invalid-timeout",
      ssh: support.SSH_ENDPOINT,
    }));
    const workerService = support.createService(
      support.createProvider({
        provision,
        resolveProvisionTimeoutMs: () => timeoutMs,
      }),
    );

    await expect(
      workerService.create("development", `request-invalid-provider-timeout-${String(timeoutMs)}`),
    ).rejects.toMatchObject({
      code: "invalid_profile",
      message: expect.stringContaining("Worker provider provision timeout must be an integer"),
    } satisfies Partial<WorkerEnvironmentServiceError>);
    expect(provision).not.toHaveBeenCalled();
  });

  it("serializes destroy and provision replay behind a timed-out provider operation", async () => {
    const events: string[] = [];
    const operationIds: string[] = [];
    let active = 0;
    let maxActive = 0;
    let originalProvisionCalls = 0;
    let finishFirstProvision: (() => void) | undefined;
    const firstProvisionPending = new Promise<void>((resolve) => {
      finishFirstProvision = resolve;
    });
    const destroy = vi.fn(async () => {
      events.push("destroy:start");
      active += 1;
      maxActive = Math.max(maxActive, active);
      active -= 1;
      events.push("destroy:end");
    });
    const provider = support.createProvider({
      provision: async (_profile, operationId) => {
        originalProvisionCalls += 1;
        const call = originalProvisionCalls;
        operationIds.push(operationId);
        events.push(`provision:${call}:start`);
        active += 1;
        maxActive = Math.max(maxActive, active);
        if (call === 1) {
          await firstProvisionPending;
        }
        active -= 1;
        events.push(`provision:${call}:end`);
        return { leaseId: "lease-timeout-replay", ssh: support.SSH_ENDPOINT };
      },
      destroy,
      resolveProvisionTimeoutMs: () => 20,
    });
    const workerService = support.createService(provider);
    const creation = workerService.create("development", "request-provider-timeout-race");
    const creationResult = expect(creation).rejects.toMatchObject({
      code: "provider_failure",
    } satisfies Partial<WorkerEnvironmentServiceError>);
    let environmentId: string | undefined;
    let teardownResult: Promise<void> | undefined;
    try {
      await support.waitForFast(() => expect(events).toEqual(["provision:1:start"]));
      const queuedEnvironmentId = expectDefined(
        support.testState.store.list()[0],
        "timed-out provision row",
      ).environmentId;
      environmentId = queuedEnvironmentId;
      const teardown = workerService.destroy(queuedEnvironmentId);
      teardownResult = expect(teardown).resolves.toMatchObject({ state: "destroyed" });
      await creationResult;
      await support.waitForFast(() =>
        expect(
          support.testState.store.get(queuedEnvironmentId)?.destroyRequestedAtMs,
        ).not.toBeNull(),
      );
      expect(originalProvisionCalls).toBe(1);
      expect(destroy).not.toHaveBeenCalled();
      expect(maxActive).toBe(1);
    } finally {
      finishFirstProvision?.();
    }

    await teardownResult;
    const finalEnvironmentId = expectDefined(environmentId, "timed-out provision environment id");
    expect(operationIds).toHaveLength(2);
    expect(new Set(operationIds).size).toBe(1);
    expect(maxActive).toBe(1);
    expect(events).toEqual([
      "provision:1:start",
      "provision:1:end",
      "provision:2:start",
      "provision:2:end",
      "destroy:start",
      "destroy:end",
    ]);
    expect(support.testState.store.get(finalEnvironmentId)).toMatchObject({ state: "destroyed" });
  });

  it("adopts an indeterminate allocation before a replay preparation failure", async () => {
    const events: string[] = [];
    let preparationFails = false;
    support.testState.prepareInstallation = vi.fn(async () => {
      events.push("prepare");
      if (preparationFails) {
        throw new Error("persisted bundle is unavailable");
      }
      return support.BUNDLE_ARTIFACT;
    });
    let provisionCalls = 0;
    const operationIds: string[] = [];
    const provider = support.createProvider({
      provision: async (_profile, operationId) => {
        events.push("provision");
        provisionCalls += 1;
        operationIds.push(operationId);
        if (provisionCalls === 1) {
          throw new Error("provision response was lost");
        }
        return { leaseId: "lease-replayed", ssh: support.SSH_ENDPOINT };
      },
      destroy: async () => void events.push("destroy"),
    });
    const workerService = support.createService(provider);

    await expect(
      workerService.create("development", "request-lost-provision"),
    ).rejects.toMatchObject({
      code: "provider_failure",
    } satisfies Partial<WorkerEnvironmentServiceError>);
    preparationFails = true;
    await workerService.reconcileOnce();

    expect(events).toEqual(["prepare", "provision", "provision", "prepare", "destroy"]);
    expect(new Set(operationIds).size).toBe(1);
    expect(support.testState.store.list()[0]).toMatchObject({
      state: "failed",
      leaseId: null,
      sshEndpoint: null,
      teardownTerminalState: "failed",
      lastError: "persisted bundle is unavailable",
    });
  });

  it.each([
    ["missing result", null, "invalid provision result"],
    ["missing transport", { leaseId: "lease-invalid" }, "invalid provision result"],
    [
      "ambiguous transport",
      { leaseId: "lease-invalid", ssh: support.SSH_ENDPOINT, node: { deviceId: "device-1" } },
      "invalid provision result",
    ],
    [
      "blank node device id",
      { leaseId: "lease-invalid", node: { deviceId: " " } },
      "invalid node device id",
    ],
    [
      "malformed SSH endpoint",
      { leaseId: "lease-invalid", ssh: { ...support.SSH_ENDPOINT, keyRef: "not-a-secret-ref" } },
      "SSH key must be a canonical SecretRef",
    ],
    [
      "excessive SSH fallback ports",
      {
        leaseId: "lease-invalid",
        ssh: {
          ...support.SSH_ENDPOINT,
          fallbackPorts: Array.from({ length: 11 }, (_, index) => 2300 + index),
        },
      },
      "SSH fallback ports cannot exceed 10",
    ],
    [
      "invalid shared-host declaration",
      { leaseId: "lease-invalid", ssh: support.SSH_ENDPOINT, sharedHost: "yes" },
      "invalid provision result",
    ],
    [
      "unsupported desktop protocol",
      {
        leaseId: "lease-invalid",
        ssh: support.SSH_ENDPOINT,
        desktop: { protocol: "rdp", port: 5900 },
      },
      'desktop protocol must be "rfb"',
    ],
    [
      "invalid desktop port",
      {
        leaseId: "lease-invalid",
        ssh: support.SSH_ENDPOINT,
        desktop: { protocol: "rfb", port: 0 },
      },
      "desktop port must be an integer",
    ],
    [
      "relative desktop password path",
      {
        leaseId: "lease-invalid",
        ssh: support.SSH_ENDPOINT,
        desktop: { protocol: "rfb", port: 5900, passwordFilePath: "vnc.password" },
      },
      "desktop password file path must be absolute",
    ],
    [
      "unrecognized desktop app metadata",
      {
        leaseId: "lease-invalid",
        ssh: support.SSH_ENDPOINT,
        desktop: {
          protocol: "rfb",
          port: 5900,
          apps: [
            {
              id: "browser",
              executablePath: "/usr/local/bin/openclaw-worker-browser",
              cdpPort: 9222,
              command: "chromium",
            },
          ],
        },
      },
      "browser desktop app contains unknown fields",
    ],
  ])("keeps %s from a provider retryable", async (_name, result, error) => {
    const workerService = support.createService(
      support.createProvider({ provision: async () => result as never }),
    );

    await expect(workerService.create("development", "request-malformed")).rejects.toMatchObject({
      code: "provider_failure",
      message: expect.stringContaining(error),
    } satisfies Partial<WorkerEnvironmentServiceError>);
    expect(support.testState.store.list()[0]).toMatchObject({
      state: "provisioning",
      lastError: expect.stringContaining(error),
    });
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
